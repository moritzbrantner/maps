//! Cartography for tileset style layers (Milestone E, #321): MapLibre style-spec `fill`,
//! `line`, `circle` and `symbol` layers (point and line placement, text and icons along
//! lines, `icon-text-fit`, rotation and translation, zoom-dependent sizes and paint,
//! variable text anchors, #346)
//! over vector tiles, with SDF glyphs, shaping,
//! collision and style images (sprites, patterns, #323) ported from MapLibre GL JS 6.15.
//! Renderers own the pixels; this module owns the layout.

pub mod collision;
pub mod color;
pub mod expression;
pub mod glyphs;
pub mod images;
pub mod layout;
pub mod line_anchors;
pub mod polylabel;
pub mod projection;
pub mod shaping;
pub mod style;
pub mod variable_anchors;
pub mod zoom;

pub use collision::{
    PlacedSymbol, PlacementTile, VariableAnchorMemory, place_symbols, symbol_tile_order,
};
pub use glyphs::{AtlasRect, GlyphAtlas, GlyphStore, parse_glyph_pbf};
pub use images::{
    CrossfadeParameters, FADE_DURATION_MS, ImageAtlas, ImagePosition, ImageStore, LinePattern,
    PatternVertex, StyleImage, ZoomHistory,
};
pub use layout::{
    IconQuad, LayerBucket, LineText, SymbolBucket, SymbolGlyph, SymbolIcon, SymbolInstance,
    SymbolLine, SymbolPaint, SymbolPlacement, SymbolText, SymbolTranslate, TileCircle, TileDash,
    TileFill, TileLine, TileStyleBuckets, VariableText, layout_tile,
};
pub use projection::{LineGlyphs, LineLabelContext, TileProjection, line_label_glyphs};
pub use style::{StyleLayer, StyleLayerKind};
pub use zoom::{SizeData, SymbolDrawState, ZoomedPaint};
