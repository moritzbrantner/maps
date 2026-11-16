//! Cartography for tileset style layers (Milestone E, #321): MapLibre style-spec `fill`,
//! `line`, `circle` and `symbol` layers (point and line placement, text and icons along
//! lines, `icon-text-fit`, rotation and translation, map or viewport alignment, zoom-dependent
//! sizes and paint,
//! variable text anchors, symbol sort keys and z-order, #346)
//! over vector tiles, with SDF glyphs, shaping,
//! collision and style images (sprites, patterns, #323) ported from MapLibre GL JS 6.15
//! to 6.17. Renderers own the pixels; this module owns the layout, placement and the order
//! symbols draw in.

pub mod collision;
pub mod color;
pub mod expression;
pub mod glyphs;
pub mod images;
pub mod layout;
pub mod line_anchors;
pub mod order;
pub mod overzoom;
pub mod polylabel;
pub mod projection;
pub mod query;
pub mod shaping;
pub mod style;
pub mod variable_anchors;
pub mod zoom;

pub use collision::{
    PlacedSymbol, PlacementTile, SymbolCollision, VariableAnchorMemory, place_symbols,
    place_symbols_with_collisions, symbol_tile_order,
};
pub use glyphs::{AtlasRect, GlyphAtlas, GlyphStore, parse_glyph_pbf};
pub use images::{
    CrossfadeParameters, FADE_DURATION_MS, ImageAtlas, ImagePosition, ImageStore, LinePattern,
    PatternVertex, StyleImage, ZoomHistory,
};
pub use layout::{
    IconQuad, LayerBucket, LineText, SymbolBucket, SymbolGlyph, SymbolIcon, SymbolInstance,
    SymbolLine, SymbolPaint, SymbolPlacement, SymbolText, SymbolTranslate, TileCircle, TileDash,
    TileFill, TileLine, TileStyleBuckets, VariableText, layout_overscaled_tile, layout_tile,
};
pub use order::{SymbolDrawGroup, draw_groups, placement_order, viewport_y_order};
pub use overzoom::{ZOOM_LEVELS_TO_OVERSCALE, slice_tile_layers, split_max_zoom};
pub use projection::{
    LabelAxes, LineGlyphs, LineLabelContext, SymbolAlignment, TileProjection, line_label_glyphs,
};
pub use query::{RenderedFeatureHit, RenderedFeatureIndex, query_layer_indices, rendered_feature};
pub use style::{StyleLayer, StyleLayerKind};
pub use zoom::{SizeData, SymbolDrawState, ZoomedPaint};
