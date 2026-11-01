//! Style images (#323): sprite sheets and the image atlas that `fill-pattern` (and, later,
//! symbol icons, #346) sample.
//!
//! Ports MapLibre 6.15 `load_sprite.ts` (a sprite JSON index over one RGBA sheet),
//! `image_atlas.ts` (`ImagePosition`, icon and pattern bins packed by `potpack` with one pixel
//! of padding, patterns padded with a copy wrapped from their opposite edge so `LINEAR`
//! sampling repeats seamlessly) and `zoom_history.ts` / `EvaluationParameters`' pattern
//! cross-fade. MapLibre packs one atlas per tile; Maps packs one over every image any layer
//! asked for, which samples identically. The atlas holds premultiplied RGBA, as MapLibre's
//! texture upload premultiplies (`premultiplyAlpha`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::glyphs::{AtlasRect, potpack};

/// MapLibre's `IMAGE_PADDING`.
pub const IMAGE_PADDING: u32 = 1;

/// One style image: straight RGBA pixels and how the style places them.
#[derive(Clone, Debug, PartialEq)]
pub struct StyleImage {
    pub width: u32,
    pub height: u32,
    pub pixel_ratio: f64,
    pub sdf: bool,
    /// Straight-alpha RGBA, `width * height * 4` bytes.
    pub data: Vec<u8>,
}

/// An image's place in the atlas (MapLibre's `ImagePosition`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImagePosition {
    /// The bin, padding included.
    pub padded: AtlasRect,
    pub pixel_ratio: f64,
    pub sdf: bool,
}

impl ImagePosition {
    /// Top-left of the image inside its bin, in atlas pixels.
    #[must_use]
    pub fn tl(&self) -> [f64; 2] {
        [
            f64::from(self.padded.x + IMAGE_PADDING),
            f64::from(self.padded.y + IMAGE_PADDING),
        ]
    }

    /// Bottom-right of the image inside its bin, in atlas pixels.
    #[must_use]
    pub fn br(&self) -> [f64; 2] {
        [
            f64::from(self.padded.x + self.padded.w - IMAGE_PADDING),
            f64::from(self.padded.y + self.padded.h - IMAGE_PADDING),
        ]
    }

    /// The image size in CSS px: its pixels over its pixel ratio.
    #[must_use]
    pub fn display_size(&self) -> [f64; 2] {
        [
            f64::from(self.padded.w - 2 * IMAGE_PADDING) / self.pixel_ratio,
            f64::from(self.padded.h - 2 * IMAGE_PADDING) / self.pixel_ratio,
        ]
    }
}

/// The packed icons and patterns, premultiplied RGBA.
#[derive(Clone, Debug, Default)]
pub struct ImageAtlas {
    pub width: u32,
    pub height: u32,
    pub image: Vec<u8>,
    icons: BTreeMap<String, ImagePosition>,
    patterns: BTreeMap<String, ImagePosition>,
    /// Bumped on every rebuild so renderers re-upload and rebuild baked positions.
    pub revision: u64,
}

impl ImageAtlas {
    fn new(
        images: &BTreeMap<String, StyleImage>,
        icons: &BTreeSet<String>,
        patterns: &BTreeSet<String>,
    ) -> Self {
        let bin = |image: &StyleImage| AtlasRect {
            x: 0,
            y: 0,
            w: image.width + 2 * IMAGE_PADDING,
            h: image.height + 2 * IMAGE_PADDING,
        };
        // Icons, then patterns, as MapLibre's `ImageAtlas` adds them.
        let entries: Vec<(&String, &StyleImage, bool)> = icons
            .iter()
            .filter_map(|id| images.get(id).map(|image| (id, image, false)))
            .chain(
                patterns
                    .iter()
                    .filter_map(|id| images.get(id).map(|image| (id, image, true))),
            )
            .collect();
        let mut bins: Vec<AtlasRect> = entries.iter().map(|(_, image, _)| bin(image)).collect();
        let (width, height) = potpack(&mut bins);
        let (width, height) = (width.max(1), height.max(1));
        let mut image = vec![0_u8; width as usize * height as usize * 4];
        let mut atlas_icons = BTreeMap::new();
        let mut atlas_patterns = BTreeMap::new();
        for ((id, source, pattern), padded) in entries.into_iter().zip(bins) {
            let (x, y) = (padded.x + IMAGE_PADDING, padded.y + IMAGE_PADDING);
            let (w, h) = (source.width, source.height);
            copy(source, &mut image, width, [0, 0], [x, y], [w, h]);
            if pattern {
                // One pixel of wrapped padding on each side (T, B, L, R).
                copy(source, &mut image, width, [0, h - 1], [x, y - 1], [w, 1]);
                copy(source, &mut image, width, [0, 0], [x, y + h], [w, 1]);
                copy(source, &mut image, width, [w - 1, 0], [x - 1, y], [1, h]);
                copy(source, &mut image, width, [0, 0], [x + w, y], [1, h]);
            }
            let position = ImagePosition {
                padded,
                pixel_ratio: source.pixel_ratio,
                sdf: source.sdf,
            };
            if pattern {
                atlas_patterns.insert(id.clone(), position);
            } else {
                atlas_icons.insert(id.clone(), position);
            }
        }
        premultiply(&mut image);
        static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self {
            width,
            height,
            image,
            icons: atlas_icons,
            patterns: atlas_patterns,
            revision: REVISION.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    #[must_use]
    pub fn pattern(&self, id: &str) -> Option<ImagePosition> {
        self.patterns.get(id).copied()
    }

    #[must_use]
    pub fn icon(&self, id: &str) -> Option<ImagePosition> {
        self.icons.get(id).copied()
    }
}

/// `RGBAImage.copy` from a style image into the atlas.
fn copy(
    source: &StyleImage,
    atlas: &mut [u8],
    atlas_width: u32,
    from: [u32; 2],
    to: [u32; 2],
    size: [u32; 2],
) {
    let row_bytes = size[0] as usize * 4;
    for row in 0..size[1] {
        let src = ((from[1] + row) as usize * source.width as usize + from[0] as usize) * 4;
        let dst = ((to[1] + row) as usize * atlas_width as usize + to[0] as usize) * 4;
        atlas[dst..dst + row_bytes].copy_from_slice(&source.data[src..src + row_bytes]);
    }
}

/// MapLibre's `premultiplyAlpha`, applied when its texture uploads RGBA.
fn premultiply(data: &mut [u8]) {
    for pixel in data.as_chunks_mut::<4>().0 {
        let alpha = f64::from(pixel[3]);
        for channel in &mut pixel[..3] {
            // `Math.round` of a non-negative value.
            *channel = (f64::from(*channel) * alpha / 255.0 + 0.5).floor() as u8;
        }
    }
}

/// The style's images and the subsets layers asked for as icons and patterns.
#[derive(Default)]
pub struct ImageStore {
    images: BTreeMap<String, StyleImage>,
    icons: BTreeSet<String>,
    patterns: BTreeSet<String>,
    atlas: Option<ImageAtlas>,
}

impl ImageStore {
    /// Adds every image a sprite JSON index names, cut from its straight-alpha RGBA sheet
    /// (`width` x `height`). Returns the number of images.
    pub fn add_sprite(
        &mut self,
        json: &str,
        sheet: &[u8],
        width: u32,
        height: u32,
    ) -> Result<usize, String> {
        if sheet.len() != width as usize * height as usize * 4 {
            return Err("sprite sheet size does not match its RGBA pixels".to_owned());
        }
        let index: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let index = index
            .as_object()
            .ok_or("a sprite index must be an object")?;
        let mut added = 0;
        for (id, entry) in index {
            let number = |key: &str| entry.get(key).and_then(Value::as_f64);
            let dimension = |key: &str| -> Result<u32, String> {
                number(key)
                    .filter(|value| value.fract() == 0.0 && *value >= 0.0)
                    .map(|value| value as u32)
                    .ok_or_else(|| format!("sprite image {id}: invalid {key}"))
            };
            let (x, y, w, h) = (
                dimension("x")?,
                dimension("y")?,
                dimension("width")?,
                dimension("height")?,
            );
            if x + w > width || y + h > height || w == 0 || h == 0 {
                return Err(format!("sprite image {id} lies outside its sheet"));
            }
            let pixel_ratio = number("pixelRatio").unwrap_or(1.0);
            if !(pixel_ratio.is_finite() && pixel_ratio > 0.0) {
                return Err(format!("sprite image {id}: invalid pixelRatio"));
            }
            let mut data = Vec::with_capacity(w as usize * h as usize * 4);
            for row in y..y + h {
                let start = (row as usize * width as usize + x as usize) * 4;
                data.extend_from_slice(&sheet[start..start + w as usize * 4]);
            }
            self.images.insert(
                id.clone(),
                StyleImage {
                    width: w,
                    height: h,
                    pixel_ratio,
                    sdf: entry.get("sdf").and_then(Value::as_bool).unwrap_or(false),
                    data,
                },
            );
            added += 1;
        }
        self.atlas = None;
        Ok(added)
    }

    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.images.contains_key(id)
    }

    #[must_use]
    pub fn image(&self, id: &str) -> Option<&StyleImage> {
        self.images.get(id)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.images.is_empty()
    }

    /// Asks for `id` as a pattern. The atlas repacks when the image is new to it; an image
    /// the sprite lacks (or a sprite still loading) joins once it is added.
    pub fn request_pattern(&mut self, id: &str) {
        if self.patterns.insert(id.to_owned()) && self.images.contains_key(id) {
            self.atlas = None;
        }
    }

    /// Asks for `id` as an icon, like [`Self::request_pattern`].
    pub fn request_icon(&mut self, id: &str) {
        if self.icons.insert(id.to_owned()) && self.images.contains_key(id) {
            self.atlas = None;
        }
    }

    /// The atlas over every requested image; repacked after requests or sprites changed it.
    pub fn atlas(&mut self) -> &ImageAtlas {
        self.atlas
            .get_or_insert_with(|| ImageAtlas::new(&self.images, &self.icons, &self.patterns))
    }
}

/// MapLibre's `CrossfadeParameters`: patterns of the two nearest integer zooms, drawn at
/// `from_scale` and `to_scale` of their size, mixed by `t`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CrossfadeParameters {
    pub from_scale: f64,
    pub to_scale: f64,
    pub t: f64,
}

/// MapLibre's default `fadeDuration` in ms.
pub const FADE_DURATION_MS: f64 = 300.0;

/// MapLibre's `ZoomHistory`: the last integer zoom crossed and when, which drive the
/// pattern cross-fade.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ZoomHistory {
    started: bool,
    last_zoom: f64,
    last_floor_zoom: f64,
    last_integer_zoom: f64,
    last_integer_zoom_time: f64,
}

impl ZoomHistory {
    /// Records the camera zoom `z` at `now` (ms). Returns whether the zoom changed.
    pub fn update(&mut self, z: f64, now: f64) -> bool {
        let floor = z.floor();
        if !self.started {
            self.started = true;
            self.last_integer_zoom = floor;
            self.last_integer_zoom_time = 0.0;
            self.last_zoom = z;
            self.last_floor_zoom = floor;
            return true;
        }
        if self.last_floor_zoom > floor {
            self.last_integer_zoom = floor + 1.0;
            self.last_integer_zoom_time = now;
        } else if self.last_floor_zoom < floor {
            self.last_integer_zoom = floor;
            self.last_integer_zoom_time = now;
        }
        if z != self.last_zoom {
            self.last_zoom = z;
            self.last_floor_zoom = floor;
            return true;
        }
        false
    }

    /// `EvaluationParameters.crossFadingFactor`: 1 once `fade_duration` passed since the last
    /// integer zoom was crossed.
    #[must_use]
    pub fn crossfading_factor(&self, now: f64, fade_duration: f64) -> f64 {
        if fade_duration == 0.0 {
            1.0
        } else {
            ((now - self.last_integer_zoom_time) / fade_duration).min(1.0)
        }
    }

    /// `EvaluationParameters.getCrossfadeParameters` at zoom `z`.
    #[must_use]
    pub fn crossfade(&self, z: f64, now: f64, fade_duration: f64) -> CrossfadeParameters {
        let fraction = z - z.floor();
        let t = self.crossfading_factor(now, fade_duration);
        if z > self.last_integer_zoom {
            CrossfadeParameters {
                from_scale: 2.0,
                to_scale: 1.0,
                t: fraction + (1.0 - fraction) * t,
            }
        } else {
            CrossfadeParameters {
                from_scale: 0.5,
                to_scale: 1.0,
                t: 1.0 - (1.0 - t) * fraction,
            }
        }
    }
}

/// A pattern's paint at one vertex: what MapLibre's pattern programs read from
/// `pattern_from`/`pattern_to`, `pixel_ratio_*` and `get_pattern_pos`, with the tile's pixel
/// offset folded in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PatternVertex {
    /// Position in pattern pixels at the camera's tile zoom, less a whole number of
    /// `2 * display_size` periods so it stays small: `v_pos = pixel / (scale * display_size)`
    /// for every cross-fade scale (0.5, 1, 2).
    pub pixel: [f64; 2],
    /// Atlas-normalized corners of the image.
    pub uv_tl: [f64; 2],
    pub uv_br: [f64; 2],
    pub display_size: [f64; 2],
}

/// The pattern period every cross-fade scale divides: twice the display size.
#[must_use]
pub fn pattern_period(position: &ImagePosition) -> [f64; 2] {
    let size = position.display_size();
    [size[0] * 2.0, size[1] * 2.0]
}

impl PatternVertex {
    /// `pixel` is the vertex in pixels at the tile zoom, `origin` a nearby reference point
    /// (the tile corner or a retained anchor) whose whole periods are removed.
    #[must_use]
    pub fn new(
        position: &ImagePosition,
        atlas: &ImageAtlas,
        pixel: [f64; 2],
        origin: [f64; 2],
    ) -> Self {
        let period = pattern_period(position);
        let base = [
            origin[0] - origin[0].rem_euclid(period[0]),
            origin[1] - origin[1].rem_euclid(period[1]),
        ];
        let (tl, br) = (position.tl(), position.br());
        let (width, height) = (f64::from(atlas.width), f64::from(atlas.height));
        Self {
            pixel: [pixel[0] - base[0], pixel[1] - base[1]],
            uv_tl: [tl[0] / width, tl[1] / height],
            uv_br: [br[0] / width, br[1] / height],
            display_size: position.display_size(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2 x 2 sheet: red, green / blue, half-transparent white.
    fn sheet() -> Vec<u8> {
        vec![
            255, 0, 0, 255, 0, 255, 0, 255, //
            0, 0, 255, 255, 255, 255, 255, 128,
        ]
    }

    #[test]
    fn sprite_images_pack_with_wrapped_pattern_padding_and_premultiplied_alpha() {
        let mut store = ImageStore::default();
        let json = r#"{"all":{"x":0,"y":0,"width":2,"height":2,"pixelRatio":2},"red":{"x":0,"y":0,"width":1,"height":1}}"#;
        assert_eq!(store.add_sprite(json, &sheet(), 2, 2), Ok(2));
        store.request_pattern("all");
        store.request_pattern("missing");
        let atlas = store.atlas().clone();
        let position = atlas.pattern("all").unwrap();
        assert_eq!((atlas.width, atlas.height), (4, 4));
        assert_eq!(position.tl(), [1.0, 1.0]);
        assert_eq!(position.br(), [3.0, 3.0]);
        assert_eq!(position.display_size(), [1.0, 1.0]);
        assert!(atlas.pattern("missing").is_none());
        let pixel = |x: usize, y: usize| &atlas.image[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
        // The image itself, white premultiplied by its 128 alpha.
        assert_eq!(pixel(1, 1), &[255, 0, 0, 255]);
        assert_eq!(pixel(2, 2), &[128, 128, 128, 128]);
        // Top padding wraps the bottom row, left padding the right column.
        assert_eq!(pixel(1, 0), &[0, 0, 255, 255]);
        assert_eq!(pixel(0, 1), &[0, 255, 0, 255]);
        // Corners stay empty, as MapLibre leaves them.
        assert_eq!(pixel(0, 0), &[0, 0, 0, 0]);

        // Icons get transparent padding.
        store.request_icon("red");
        let atlas = store.atlas();
        let icon = atlas.icon("red").unwrap();
        let [x, y] = icon.tl();
        let around = (y as usize - 1) * atlas.width as usize + x as usize;
        assert_eq!(&atlas.image[around * 4..around * 4 + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn invalid_sprites_are_rejected() {
        let mut store = ImageStore::default();
        assert!(
            store
                .add_sprite(
                    r#"{"a":{"x":1,"y":0,"width":2,"height":2}}"#,
                    &sheet(),
                    2,
                    2
                )
                .is_err()
        );
        assert!(store.add_sprite("{}", &sheet(), 3, 2).is_err());
    }

    #[test]
    fn zoom_history_cross_fades_patterns_of_neighbouring_zooms() {
        let mut history = ZoomHistory::default();
        // The first zoom has no fade.
        history.update(8.4, 1000.0);
        assert_eq!(
            history.crossfade(8.4, 1000.0, FADE_DURATION_MS),
            CrossfadeParameters {
                from_scale: 2.0,
                to_scale: 1.0,
                t: 1.0
            }
        );
        // Zooming in across 9 fades from the half-size pattern of zoom 8.
        history.update(9.25, 2000.0);
        let fade = history.crossfade(9.25, 2150.0, FADE_DURATION_MS);
        assert_eq!((fade.from_scale, fade.to_scale), (2.0, 1.0));
        assert!((fade.t - (0.25 + 0.75 * 0.5)).abs() < 1e-12);
        // Zooming out below 9 fades the other way.
        history.update(8.5, 3000.0);
        let fade = history.crossfade(8.5, 3000.0, FADE_DURATION_MS);
        assert_eq!((fade.from_scale, fade.to_scale), (0.5, 1.0));
        assert!((fade.t - 0.5).abs() < 1e-12);
        assert_eq!(history.crossfade(8.5, 3300.0, FADE_DURATION_MS).t, 1.0);
    }

    #[test]
    fn pattern_vertices_drop_whole_periods_of_their_origin() {
        let position = ImagePosition {
            padded: AtlasRect {
                x: 0,
                y: 0,
                w: 18,
                h: 18,
            },
            pixel_ratio: 1.0,
            sdf: false,
        };
        let atlas = ImageAtlas {
            width: 18,
            height: 18,
            ..ImageAtlas::default()
        };
        let vertex = PatternVertex::new(&position, &atlas, [1000.5, 70.0], [990.0, 64.0]);
        // Period 32: 990 - 990 % 32 = 960, 64 - 0 = 64.
        assert_eq!(vertex.pixel, [40.5, 6.0]);
        assert_eq!(vertex.uv_tl, [1.0 / 18.0, 1.0 / 18.0]);
        assert_eq!(vertex.uv_br, [17.0 / 18.0, 17.0 / 18.0]);
        assert_eq!(vertex.display_size, [16.0, 16.0]);
    }
}
