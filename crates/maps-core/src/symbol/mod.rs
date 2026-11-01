//! Cartography for tileset style layers (Milestone E, #321): MapLibre style-spec `fill`,
//! `line`, `circle` and point-placement `symbol` layers over vector tiles, with SDF glyphs,
//! shaping, collision and style images (sprites, patterns, #323) ported from MapLibre GL JS
//! 6.15. Renderers own the pixels; this module owns the layout.

pub mod collision;
pub mod color;
pub mod expression;
pub mod glyphs;
pub mod images;
pub mod layout;
pub mod polylabel;
pub mod shaping;
pub mod style;

pub use collision::{PlacedSymbol, PlacementTile, place_symbols, symbol_tile_order};
pub use glyphs::{AtlasRect, GlyphAtlas, GlyphStore, parse_glyph_pbf};
pub use images::{
    CrossfadeParameters, FADE_DURATION_MS, ImageAtlas, ImagePosition, ImageStore, PatternVertex,
    StyleImage, ZoomHistory,
};
pub use layout::{
    LayerBucket, SymbolInstance, TileCircle, TileDash, TileFill, TileLine, TileStyleBuckets,
    layout_tile,
};
pub use style::{StyleLayer, StyleLayerKind};
