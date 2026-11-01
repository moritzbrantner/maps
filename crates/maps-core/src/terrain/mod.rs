//! Relief (#324): `raster-dem` sources, `hillshade` layers and 3D `terrain`, ported from
//! MapLibre GL JS 6.15.
//!
//! [`ReliefPlanner`] owns the decoded DEM tiles and plans each frame the way MapLibre's tile
//! managers do: which tiles cover the view for every relief source (`coveringTiles`), which DEM
//! tile feeds every terrain tile (`TerrainTileManager.getSourceTile`), and the terrain elevation
//! under the camera center (`Terrain.getElevationForLngLat`). Renderers draw the plan.

mod covering;
mod dem;
mod style;
mod transform;

use std::collections::{BTreeSet, HashMap};

pub use covering::{CoveredTile, CoveringOptions, TileElevationRange, covering_tiles};
pub use dem::{DemData, DemEncoding};
pub use style::{
    HillshadeLayer, HillshadeLight, HillshadeMethod, ReliefStyle, TerrainSpec, TileSourceSpec,
};
pub use transform::{
    Frustum, Mat4, TILE_EXTENT, TerrainCamera, TerrainTransform, latitude_of_mercator_y, multiply,
    ortho, scale, translate,
};

use crate::TileId;

/// MapLibre's `TerrainTileManager.deltaZoom`: terrain tiles are twice the DEM tile size and
/// read the DEM tile one zoom above them.
const TERRAIN_DELTA_ZOOM: u8 = 1;
/// The terrain tile manager's own zoom range.
const TERRAIN_MAX_ZOOM: u8 = 22;
/// Fixed-point passes between the center elevation and the terrain tiles it selects.
const ELEVATION_PASSES: usize = 4;
/// Decoded DEM tiles kept per source beyond the current frame's.
const DEM_CACHE_TILES: usize = 256;

/// A terrain tile and, when loaded, the DEM tile it samples with its tile-to-DEM transform:
/// DEM `uv = position · scale + offset` for tile-local positions in `0..EXTENT`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainTilePlan {
    pub tile: CoveredTile,
    pub dem: Option<TileId>,
    pub dem_scale: f64,
    pub dem_offset: [f64; 2],
    /// Lowest and highest exaggerated elevation of its DEM tile.
    pub min_max: Option<(f64, f64)>,
}

/// One planned frame.
#[derive(Clone, Debug)]
pub struct ReliefFrame {
    pub transform: TerrainTransform,
    /// Terrain tiles, nearest first; empty without terrain.
    pub terrain: Vec<TerrainTilePlan>,
    /// Loaded tiles of each hillshade layer (by layer index), drawn in this order.
    pub hillshade: Vec<Vec<CoveredTile>>,
    /// Covering tiles of the style's raster layer under terrain.
    pub raster: Vec<CoveredTile>,
    /// Tiles this frame needs that are not loaded, as `(source index, tile)`.
    pub wanted: Vec<(usize, TileId)>,
}

/// Decoded tiles of one `raster-dem` source.
#[derive(Default)]
struct DemStore {
    tiles: HashMap<TileId, DemData>,
}

impl DemStore {
    /// Inserts a tile and backfills borders with every loaded neighbour, both ways. Returns
    /// the tiles whose pixels changed.
    fn insert(&mut self, tile: TileId, mut dem: DemData) -> Vec<TileId> {
        let mut changed = vec![tile];
        let dimension = 1_i64 << tile.z;
        for dy in -1_i64..=1 {
            for dx in -1_i64..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let y = i64::from(tile.y) + dy;
                if !(0..dimension).contains(&y) {
                    continue;
                }
                let x = (i64::from(tile.x) + dx).rem_euclid(dimension);
                let neighbour = TileId {
                    z: tile.z,
                    x: x as u32,
                    y: y as u32,
                };
                let Some(other) = self.tiles.get_mut(&neighbour) else {
                    continue;
                };
                dem.backfill_border(other, dx as isize, dy as isize);
                other.backfill_border(&dem, -dx as isize, -dy as isize);
                changed.push(neighbour);
            }
        }
        self.tiles.insert(tile, dem);
        changed
    }

    fn prune(&mut self, keep: &BTreeSet<TileId>) {
        if self.tiles.len() <= DEM_CACHE_TILES {
            return;
        }
        self.tiles.retain(|tile, _| keep.contains(tile));
    }
}

/// Plans relief frames and owns their DEM tiles.
#[derive(Default)]
pub struct ReliefPlanner {
    style: ReliefStyle,
    dems: HashMap<usize, DemStore>,
    /// Raster tiles the renderer holds for the style raster under terrain.
    rasters: BTreeSet<TileId>,
    elevation: f64,
    min_elevation: f64,
    /// DEM tiles whose pixels changed since the renderer last took them.
    dirty: BTreeSet<(usize, TileId)>,
}

impl ReliefPlanner {
    /// Replaces the style. DEM tiles of sources that keep their id and encoding are kept.
    pub fn set_style(&mut self, style: ReliefStyle) {
        let mut dems = HashMap::new();
        for (index, source) in style.sources.iter().enumerate() {
            let previous = self.style.sources.iter().position(|old| old == source);
            if let Some(store) = previous.and_then(|old| self.dems.remove(&old)) {
                dems.insert(index, store);
            }
        }
        if style.terrain.is_none() {
            self.elevation = 0.0;
            self.min_elevation = 0.0;
        }
        self.style = style;
        self.dems = dems;
        self.rasters.clear();
        self.dirty.clear();
    }

    #[must_use]
    pub fn style(&self) -> &ReliefStyle {
        &self.style
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        !self.style.is_empty()
    }

    /// Adds a decoded DEM tile of `source` from straight RGBA bytes.
    pub fn add_dem_tile(
        &mut self,
        source: usize,
        tile: TileId,
        size: usize,
        rgba: &[u8],
    ) -> Result<(), String> {
        let encoding = self
            .style
            .sources
            .get(source)
            .and_then(|spec| spec.encoding)
            .ok_or("not a raster-dem source")?;
        let dem = DemData::new(size, rgba, encoding).ok_or("DEM tiles must be square RGBA")?;
        let changed = self.dems.entry(source).or_default().insert(tile, dem);
        self.dirty
            .extend(changed.into_iter().map(|tile| (source, tile)));
        Ok(())
    }

    /// Records that the renderer holds (or dropped) a raster tile of the style raster.
    pub fn set_raster_loaded(&mut self, tile: TileId, loaded: bool) {
        if loaded {
            self.rasters.insert(tile);
        } else {
            self.rasters.remove(&tile);
        }
    }

    #[must_use]
    pub fn dem(&self, source: usize, tile: TileId) -> Option<&DemData> {
        self.dems.get(&source)?.tiles.get(&tile)
    }

    /// DEM tiles whose pixels changed since the last call.
    pub fn take_dirty(&mut self) -> Vec<(usize, TileId)> {
        std::mem::take(&mut self.dirty).into_iter().collect()
    }

    /// `TerrainTileManager.getSourceTile(tileID, true)`: the DEM tile one zoom above a terrain
    /// tile (clamped to the source's zooms), or its nearest loaded ancestor.
    fn terrain_source_tile(&self, z: u8, x: u32, y: u32) -> Option<TileId> {
        let terrain = self.style.terrain?;
        let spec = &self.style.sources[terrain.source];
        let store = self.dems.get(&terrain.source)?;
        let mut source_z = i32::from(z) - i32::from(TERRAIN_DELTA_ZOOM);
        source_z = source_z.min(i32::from(spec.max_zoom));
        if source_z < i32::from(spec.min_zoom) {
            return None;
        }
        while source_z >= i32::from(spec.min_zoom) {
            let shift = i32::from(z) - source_z;
            let candidate = if shift >= 0 {
                TileId {
                    z: source_z as u8,
                    x: x >> shift,
                    y: y >> shift,
                }
            } else {
                return None;
            };
            if store.tiles.contains_key(&candidate) {
                return Some(candidate);
            }
            source_z -= 1;
        }
        None
    }

    /// `Terrain.getMinMaxElevation`.
    fn min_max(&self, z: u8, x: u32, y: u32) -> Option<(f64, f64)> {
        let terrain = self.style.terrain?;
        let tile = self.terrain_source_tile(z, x, y)?;
        let dem = self.dem(terrain.source, tile)?;
        Some((
            dem.min() * terrain.exaggeration,
            dem.max() * terrain.exaggeration,
        ))
    }

    fn terrain_tile_plan(&self, tile: CoveredTile) -> TerrainTilePlan {
        let dem = self.terrain_source_tile(tile.z, tile.x, tile.y);
        let (dem_scale, dem_offset) = dem.map_or((0.0, [0.0, 0.0]), |source| {
            let dz = tile.z - source.z;
            let dx = tile.x - ((tile.x >> dz) << dz);
            let dy = tile.y - ((tile.y >> dz) << dz);
            let tiles = f64::from(1_u32 << dz);
            (
                1.0 / (TILE_EXTENT * tiles),
                [f64::from(dx) / tiles, f64::from(dy) / tiles],
            )
        });
        TerrainTilePlan {
            tile,
            dem,
            dem_scale,
            dem_offset,
            min_max: self.min_max(tile.z, tile.x, tile.y),
        }
    }

    /// Elevation (m, exaggerated) of the terrain under a Mercator point, sampled from the
    /// terrain tiles drawn (`TerrainCoverage.sample`), highest zoom first.
    fn drawn_elevation(&self, tiles: &[TerrainTilePlan], x: f64, y: f64) -> Option<f64> {
        let terrain = self.style.terrain?;
        if !(0.0..1.0).contains(&y) {
            return None;
        }
        let wrap = x.floor();
        let wrapped = x - wrap;
        let mut zooms: Vec<u8> = tiles.iter().map(|plan| plan.tile.z).collect();
        zooms.sort_unstable_by(|a, b| b.cmp(a));
        zooms.dedup();
        for z in zooms {
            let scale = f64::from(1_u32 << z);
            let (sx, sy) = (wrapped * scale, y * scale);
            let (tx, ty) = (sx.floor(), sy.floor());
            let Some(plan) = tiles.iter().find(|plan| {
                plan.tile.z == z
                    && f64::from(plan.tile.x) == tx
                    && f64::from(plan.tile.y) == ty
                    && f64::from(plan.tile.wrap) == wrap
            }) else {
                continue;
            };
            let max = TILE_EXTENT * (1.0 - 1e-12);
            let px = ((sx - tx) * TILE_EXTENT).min(max);
            let py = ((sy - ty) * TILE_EXTENT).min(max);
            return self
                .tile_elevation(plan.tile, px, py)
                .map(|elevation| elevation * terrain.exaggeration);
        }
        None
    }

    /// Unexaggerated DEM elevation at tile-local `(x, y)` (`TerrainCoverage` sampler).
    fn tile_elevation(&self, tile: CoveredTile, x: f64, y: f64) -> Option<f64> {
        let terrain = self.style.terrain?;
        let source = self.terrain_source_tile(tile.z, tile.x, tile.y)?;
        let dem = self.dem(terrain.source, source)?;
        let dz = tile.z - source.z;
        let tiles = f64::from(1_u32 << dz);
        let dim = dem.dim() as f64;
        let pixel_scale = dim / (TILE_EXTENT * tiles);
        let offset_x = f64::from(tile.x - ((tile.x >> dz) << dz)) / tiles * dim - 0.5;
        let offset_y = f64::from(tile.y - ((tile.y >> dz) << dz)) / tiles * dim - 0.5;
        Some(dem.sample_bilinear(x * pixel_scale + offset_x, y * pixel_scale + offset_y))
    }

    /// Plans one frame for a camera (`longitude`, `latitude`, `zoom`, `bearing`, `pitch`,
    /// CSS `width × height`).
    pub fn plan(&mut self, mut camera: TerrainCamera) -> Option<ReliefFrame> {
        let terrain = self.style.terrain;
        let terrain_options = terrain.map(|terrain| {
            let spec = &self.style.sources[terrain.source];
            CoveringOptions {
                tile_size: spec.tile_size * 2.0,
                min_zoom: 0,
                max_zoom: TERRAIN_MAX_ZOOM,
                round_zoom: false,
            }
        });
        let center = TerrainTransform::new(TerrainCamera {
            elevation: 0.0,
            min_elevation_for_current_tile: 0.0,
            ..camera
        })?
        .center_mercator();

        let mut transform;
        let mut terrain_tiles = Vec::new();
        let mut pass = 0;
        loop {
            camera.elevation = self.elevation;
            camera.min_elevation_for_current_tile = self.min_elevation;
            transform = TerrainTransform::new(camera)?;
            let Some(options) = terrain_options else {
                break;
            };
            let min_max = |z: u8, x: u32, y: u32| self.min_max(z, x, y);
            terrain_tiles = covering_tiles(&transform, options, Some(&min_max))
                .into_iter()
                .map(|tile| self.terrain_tile_plan(tile))
                .collect::<Vec<_>>();
            let tile_zoom = camera.zoom.floor().max(0.0) as u8;
            let center_tile = |z: u8| {
                let scale = f64::from(1_u32 << z);
                let x = (center[0].rem_euclid(1.0) * scale).floor().min(scale - 1.0) as u32;
                let y = (center[1] * scale).floor().clamp(0.0, scale - 1.0) as u32;
                (
                    x,
                    y,
                    (center[0].rem_euclid(1.0) * scale).fract(),
                    (center[1] * scale).fract(),
                )
            };
            let elevation = self
                .drawn_elevation(&terrain_tiles, center[0], center[1])
                .or_else(|| {
                    let z = tile_zoom.min(TERRAIN_MAX_ZOOM);
                    let (x, y, fx, fy) = center_tile(z);
                    let tile = CoveredTile { z, x, y, wrap: 0 };
                    self.tile_elevation(tile, fx * TILE_EXTENT, fy * TILE_EXTENT)
                        .map(|elevation| {
                            elevation * terrain.map_or(1.0, |terrain| terrain.exaggeration)
                        })
                });
            let min_elevation = {
                let (x, y, _, _) = center_tile(tile_zoom);
                self.min_max(tile_zoom, x, y).map_or(0.0, |(min, _)| min)
            };
            let elevation = elevation.unwrap_or(self.elevation);
            let settled = (elevation - self.elevation).abs() < 1e-9
                && (min_elevation - self.min_elevation).abs() < 1e-9;
            self.elevation = elevation;
            self.min_elevation = min_elevation;
            pass += 1;
            if settled || pass >= ELEVATION_PASSES {
                break;
            }
        }

        let has_terrain = terrain.is_some();
        let min_max = |z: u8, x: u32, y: u32| self.min_max(z, x, y);
        let terrain_bounds: Option<TileElevationRange<'_>> =
            if has_terrain { Some(&min_max) } else { None };
        let source_cover = |source: usize| {
            let spec = &self.style.sources[source];
            covering_tiles(
                &transform,
                CoveringOptions {
                    tile_size: spec.tile_size,
                    min_zoom: spec.min_zoom,
                    max_zoom: spec.max_zoom,
                    round_zoom: true,
                },
                terrain_bounds,
            )
        };

        let mut wanted = BTreeSet::new();
        let mut want = |source: usize, tile: CoveredTile| {
            if let Some(tile) = TileId::new(tile.z, tile.x, tile.y) {
                wanted.insert((source, tile));
            }
        };
        let mut hillshade = Vec::with_capacity(self.style.hillshade.len());
        for layer in &self.style.hillshade {
            let tiles = source_cover(layer.source);
            for tile in &tiles {
                want(layer.source, *tile);
            }
            hillshade.push(
                tiles
                    .into_iter()
                    .filter(|tile| {
                        TileId::new(tile.z, tile.x, tile.y)
                            .is_some_and(|id| self.dem(layer.source, id).is_some())
                    })
                    .collect(),
            );
        }
        let mut raster = Vec::new();
        if let (Some(terrain), Some(options)) = (terrain, terrain_options) {
            // The DEM source's own tile manager: its covering at terrain tile size, plus the
            // parents terrain tiles read and a low-zoom ancestor for tile culling bounds.
            let spec = &self.style.sources[terrain.source];
            let dem_tiles = covering_tiles(
                &transform,
                CoveringOptions {
                    max_zoom: spec.max_zoom,
                    min_zoom: spec.min_zoom,
                    ..options
                },
                terrain_bounds,
            );
            for tile in dem_tiles {
                want(terrain.source, tile);
                if tile.z > spec.min_zoom {
                    let parent = |z: u8| CoveredTile {
                        z,
                        x: tile.x >> (tile.z - z),
                        y: tile.y >> (tile.z - z),
                        wrap: tile.wrap,
                    };
                    want(terrain.source, parent(tile.z - 1));
                    want(terrain.source, parent(spec.min_zoom.max(tile.z.min(5))));
                }
            }
            if let Some(source) = self.style.raster {
                raster = source_cover(source);
                for tile in &raster {
                    want(source, *tile);
                }
            }
        }

        let mut keep: HashMap<usize, BTreeSet<TileId>> = HashMap::new();
        for (source, tile) in &wanted {
            keep.entry(*source).or_default().insert(*tile);
        }
        for (source, store) in &mut self.dems {
            store.prune(keep.get(source).unwrap_or(&BTreeSet::new()));
        }
        let raster_source = self.style.raster;
        let wanted = wanted
            .into_iter()
            .filter(|(source, tile)| {
                if Some(*source) == raster_source && self.style.sources[*source].encoding.is_none()
                {
                    !self.rasters.contains(tile)
                } else {
                    self.dem(*source, *tile).is_none()
                }
            })
            .collect();

        Some(ReliefFrame {
            transform,
            terrain: terrain_tiles,
            hillshade,
            raster,
            wanted,
        })
    }
}

/// `TerrainTileManager.getTerrainCoords` for one source tile and one terrain tile: the matrix
/// from source-tile-local `0..EXTENT` to the terrain tile's render target (GL clip space, y up
/// at the tile's north edge), or `None` when they do not overlap.
#[must_use]
pub fn terrain_tile_matrix(source: CoveredTile, terrain: CoveredTile) -> Option<Mat4> {
    let extent = TILE_EXTENT;
    if source.z == terrain.z {
        return (source.x == terrain.x && source.y == terrain.y)
            .then(|| ortho(0.0, extent, extent, 0.0, 0.0, 1.0));
    }
    if terrain.z > source.z {
        let dz = terrain.z - source.z;
        if terrain.x >> dz != source.x || terrain.y >> dz != source.y {
            return None;
        }
        let dx = f64::from(terrain.x - ((terrain.x >> dz) << dz));
        let dy = f64::from(terrain.y - ((terrain.y >> dz) << dz));
        let size = extent / f64::from(1_u32 << dz);
        return Some(translate(
            ortho(0.0, size, size, 0.0, 0.0, 1.0),
            [-dx * size, -dy * size, 0.0],
        ));
    }
    let dz = source.z - terrain.z;
    if source.x >> dz != terrain.x || source.y >> dz != terrain.y {
        return None;
    }
    let dx = f64::from(source.x - ((source.x >> dz) << dz));
    let dy = f64::from(source.y - ((source.y >> dz) << dz));
    let size = extent / f64::from(1_u32 << dz);
    let tiles = f64::from(1_u32 << dz);
    Some(scale(
        translate(
            ortho(0.0, extent, extent, 0.0, 0.0, 1.0),
            [dx * size, dy * size, 0.0],
        ),
        [1.0 / tiles, 1.0 / tiles, 0.0],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terrarium_tile(height: f64) -> Vec<u8> {
        let value = height + 32768.0;
        let pixel = [
            (value / 256.0).floor() as u8,
            (value.floor() as u32 % 256) as u8,
            ((value % 1.0) * 256.0).floor() as u8,
            255,
        ];
        pixel.repeat(16 * 16)
    }

    fn planner() -> ReliefPlanner {
        let mut planner = ReliefPlanner::default();
        planner.set_style(
            ReliefStyle::parse(
                r#"{"sources": {
                  "r": {"type": "raster", "tileSize": 256, "maxzoom": 19},
                  "d": {"type": "raster-dem", "encoding": "terrarium", "tileSize": 256, "maxzoom": 12}},
                  "layers": [{"id": "r", "type": "raster", "source": "r"},
                             {"id": "h", "type": "hillshade", "source": "d"}],
                  "terrain": {"source": "d", "exaggeration": 2}}"#,
            )
            .unwrap(),
        );
        planner
    }

    fn camera() -> TerrainCamera {
        TerrainCamera {
            longitude: 9.0,
            latitude: 47.2,
            zoom: 8.0,
            bearing: 20.0,
            pitch: 55.0,
            width: 720.0,
            height: 480.0,
            elevation: 0.0,
            min_elevation_for_current_tile: 0.0,
        }
    }

    #[test]
    fn requests_dem_tiles_then_settles_on_the_center_elevation() {
        let mut planner = planner();
        let first = planner.plan(camera()).unwrap();
        assert!(!first.terrain.is_empty());
        assert!(!first.wanted.is_empty());
        for _ in 0..6 {
            let frame = planner.plan(camera()).unwrap();
            for (source, tile) in frame.wanted {
                if source == 1 {
                    planner
                        .add_dem_tile(source, tile, 16, &terrarium_tile(1000.0))
                        .unwrap();
                } else {
                    planner.set_raster_loaded(tile, true);
                }
            }
        }
        let frame = planner.plan(camera()).unwrap();
        assert!(frame.wanted.is_empty(), "{:?}", frame.wanted);
        assert!((frame.transform.camera.elevation - 2000.0).abs() < 1e-6);
        assert!(frame.terrain.iter().all(|plan| plan.dem.is_some()));
        assert!(!frame.hillshade[0].is_empty());
    }

    #[test]
    fn source_tile_matrices_cover_the_terrain_tile() {
        let terrain = CoveredTile {
            z: 8,
            x: 10,
            y: 20,
            wrap: 0,
        };
        let child = CoveredTile {
            z: 9,
            x: 21,
            y: 41,
            wrap: 0,
        };
        let matrix = terrain_tile_matrix(child, terrain).unwrap();
        // The child's north-west corner sits at the terrain tile's center.
        let clip = transform::project(matrix, [0.0, 0.0, 0.0]);
        assert!(clip[0].abs() < 1e-12 && clip[1].abs() < 1e-12);
        assert!(
            terrain_tile_matrix(
                CoveredTile {
                    z: 9,
                    x: 0,
                    y: 0,
                    wrap: 0
                },
                terrain
            )
            .is_none()
        );
    }
}
