//! MapLibre 6.15's `DEMData` (`src/data/dem_data.ts`): decoded `raster-dem` tile pixels with a
//! two-pixel border that starts as a copy of the nearest edge pixel and is later backfilled from
//! loaded neighbours, so the hillshade slope kernel and the terrain mesh see no tile seams.

/// How elevation is packed into a DEM tile's RGB channels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DemEncoding {
    /// Mapbox Terrain-RGB: `-10000 + (R·65536 + G·256 + B)·0.1` m.
    Mapbox,
    /// Mapzen Terrarium: `R·256 + G + B/256 − 32768` m.
    Terrarium,
    /// `R·red + G·green + B·blue − base_shift`.
    Custom {
        red: f64,
        green: f64,
        blue: f64,
        base_shift: f64,
    },
}

impl DemEncoding {
    /// Parses a style-spec `encoding` (with the `custom` factors).
    #[must_use]
    pub fn parse(
        name: Option<&str>,
        red: f64,
        green: f64,
        blue: f64,
        base_shift: f64,
    ) -> Option<Self> {
        match name.unwrap_or("mapbox") {
            "mapbox" => Some(Self::Mapbox),
            "terrarium" => Some(Self::Terrarium),
            "custom" => Some(Self::Custom {
                red,
                green,
                blue,
                base_shift,
            }),
            _ => None,
        }
    }

    /// `[red, green, blue, baseShift]`, MapLibre's `getUnpackVector`.
    #[must_use]
    pub fn unpack_vector(self) -> [f64; 4] {
        match self {
            Self::Mapbox => [6553.6, 25.6, 0.1, 10000.0],
            Self::Terrarium => [256.0, 1.0, 1.0 / 256.0, 32768.0],
            Self::Custom {
                red,
                green,
                blue,
                base_shift,
            } => [red, green, blue, base_shift],
        }
    }
}

/// One decoded DEM tile: `stride × stride` RGBA pixels, `dim = stride − 4` of them interior.
#[derive(Clone, Debug)]
pub struct DemData {
    pixels: Vec<[u8; 4]>,
    stride: usize,
    dim: usize,
    unpack: [f64; 4],
    min: f64,
    max: f64,
}

impl DemData {
    /// Decodes a square tile of straight RGBA bytes (`size × size`, no border). The two-pixel
    /// border is filled from the nearest edge pixel, as MapLibre's constructor does.
    #[must_use]
    pub fn new(size: usize, rgba: &[u8], encoding: DemEncoding) -> Option<Self> {
        if size == 0 || rgba.len() != size * size * 4 {
            return None;
        }
        let dim = size;
        let stride = dim + 4;
        let mut pixels = vec![[0_u8; 4]; stride * stride];
        for y in 0..dim {
            for x in 0..dim {
                let source = (y * dim + x) * 4;
                pixels[(y + 2) * stride + x + 2] = [
                    rgba[source],
                    rgba[source + 1],
                    rgba[source + 2],
                    rgba[source + 3],
                ];
            }
        }
        let mut dem = Self {
            pixels,
            stride,
            dim,
            unpack: encoding.unpack_vector(),
            min: f64::MAX,
            max: f64::MIN,
        };
        let dim = dim as isize;
        for y in -2..dim + 2 {
            let row = y.clamp(0, dim - 1);
            for x in -2..dim + 2 {
                if (0..dim).contains(&x) && (0..dim).contains(&y) {
                    continue;
                }
                let column = x.clamp(0, dim - 1);
                let value = dem.pixels[dem.index(column, row)];
                let target = dem.index(x, y);
                dem.pixels[target] = value;
            }
        }
        let (mut min, mut max) = (f64::MAX, f64::MIN);
        for y in 0..dim {
            for x in 0..dim {
                let elevation = dem.get(x, y);
                min = min.min(elevation);
                max = max.max(elevation);
            }
        }
        dem.min = min;
        dem.max = max;
        Some(dem)
    }

    fn index(&self, x: isize, y: isize) -> usize {
        (y + 2) as usize * self.stride + (x + 2) as usize
    }

    #[must_use]
    pub fn dim(&self) -> usize {
        self.dim
    }

    #[must_use]
    pub fn stride(&self) -> usize {
        self.stride
    }

    #[must_use]
    pub fn min(&self) -> f64 {
        self.min
    }

    #[must_use]
    pub fn max(&self) -> f64 {
        self.max
    }

    #[must_use]
    pub fn unpack_vector(&self) -> [f64; 4] {
        self.unpack
    }

    /// The bordered pixels, row-major, as the DEM texture holds them.
    #[must_use]
    pub fn pixels(&self) -> &[[u8; 4]] {
        &self.pixels
    }

    /// Elevation (m) of pixel `(x, y)`, `-2 ≤ x, y < dim + 2`.
    #[must_use]
    pub fn get(&self, x: isize, y: isize) -> f64 {
        let [r, g, b, _] = self.pixels[self.index(x, y)];
        f64::from(r) * self.unpack[0]
            + f64::from(g) * self.unpack[1]
            + f64::from(b) * self.unpack[2]
            - self.unpack[3]
    }

    /// Bilinear elevation at pixel coordinates (`DEMData.sampleBilinear`).
    #[must_use]
    pub fn sample_bilinear(&self, x: f64, y: f64) -> f64 {
        let cx = x.floor();
        let cy = y.floor();
        let dim = self.dim as f64;
        let cx = cx.clamp(-1.0, dim - 1.0);
        let cy = cy.clamp(-1.0, dim - 1.0);
        let tx = x - cx;
        let ty = y - cy;
        let (ix, iy) = (cx as isize, cy as isize);
        let z00 = self.get(ix, iy);
        let z10 = self.get(ix + 1, iy);
        let z01 = self.get(ix, iy + 1);
        let z11 = self.get(ix + 1, iy + 1);
        z00 * (1.0 - tx) * (1.0 - ty)
            + z10 * tx * (1.0 - ty)
            + z01 * (1.0 - tx) * ty
            + z11 * tx * ty
    }

    /// Copies the neighbour `(dx, dy)`'s edge pixels into this tile's border
    /// (`DEMData.backfillBorder`).
    pub fn backfill_border(&mut self, border: &DemData, dx: isize, dy: isize) {
        if self.dim != border.dim {
            return;
        }
        let dim = self.dim as isize;
        let (mut x_min, mut x_max) = (dx * dim, dx * dim + dim);
        let (mut y_min, mut y_max) = (dy * dim, dy * dim + dim);
        match dx {
            -1 => x_min = x_max - 2,
            1 => x_max = x_min + 2,
            _ => {}
        }
        match dy {
            -1 => y_min = y_max - 2,
            1 => y_max = y_min + 2,
            _ => {}
        }
        let (ox, oy) = (-dx * dim, -dy * dim);
        for y in y_min..y_max {
            for x in x_min..x_max {
                let target = self.index(x, y);
                self.pixels[target] = border.pixels[border.index(x + ox, y + oy)];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terrarium(height: f64) -> [u8; 4] {
        let value = height + 32768.0;
        [
            (value / 256.0).floor() as u8,
            (value.floor() as u32 % 256) as u8,
            ((value % 1.0) * 256.0).floor() as u8,
            255,
        ]
    }

    fn tile(size: usize, height: impl Fn(usize, usize) -> f64) -> DemData {
        let mut rgba = Vec::with_capacity(size * size * 4);
        for y in 0..size {
            for x in 0..size {
                rgba.extend(terrarium(height(x, y)));
            }
        }
        DemData::new(size, &rgba, DemEncoding::Terrarium).unwrap()
    }

    #[test]
    fn decodes_terrarium_with_clamped_border_and_range() {
        let dem = tile(4, |x, y| (x * 10 + y) as f64);
        assert_eq!(dem.stride(), 8);
        assert_eq!(dem.get(0, 0), 0.0);
        assert_eq!(dem.get(3, 2), 32.0);
        assert_eq!(dem.get(-2, -2), 0.0);
        assert_eq!(dem.get(5, 1), 31.0);
        assert_eq!((dem.min(), dem.max()), (0.0, 33.0));
    }

    #[test]
    fn backfills_the_border_from_the_east_neighbour() {
        let mut west = tile(4, |_, _| 1.0);
        let east = tile(4, |x, _| 100.0 + x as f64);
        west.backfill_border(&east, 1, 0);
        assert_eq!(west.get(4, 1), 100.0);
        assert_eq!(west.get(5, 1), 101.0);
        assert_eq!(west.get(-1, 1), 1.0);
    }

    #[test]
    fn samples_bilinearly_between_pixels() {
        let dem = tile(4, |x, _| x as f64 * 10.0);
        assert!((dem.sample_bilinear(1.5, 1.0) - 15.0).abs() < 1e-9);
    }
}
