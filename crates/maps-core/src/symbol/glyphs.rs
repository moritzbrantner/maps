//! SDF glyph ranges (MapLibre's glyph PBF format) and the glyph atlas they pack into.
//!
//! Ports MapLibre 6.15 `parse_glyph_pbf.ts` and `glyph_atlas.ts`: every glyph bitmap carries a
//! 3 px SDF border, and atlas bins add 1 px padding around it, packed by `potpack`.

use std::collections::{BTreeMap, BTreeSet};

use crate::vector_tile::{ProtoCursor, VectorTileError};

/// The SDF border every PBF glyph bitmap carries on each side.
pub const GLYPH_PBF_BORDER: i32 = 3;
const ATLAS_PADDING: u32 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GlyphMetrics {
    pub width: u32,
    pub height: u32,
    pub left: i32,
    pub top: i32,
    pub advance: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Glyph {
    pub id: u32,
    /// `(width + 6) x (height + 6)` alpha bytes, or empty for glyphs without ink (space).
    pub bitmap: Vec<u8>,
    pub metrics: GlyphMetrics,
}

/// Parses one glyph range PBF (`fontstacks { glyphs { ... } }`).
pub fn parse_glyph_pbf(bytes: &[u8]) -> Result<Vec<Glyph>, VectorTileError> {
    let mut glyphs = Vec::new();
    let mut cursor = ProtoCursor::new(bytes);
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        if field != 1 || wire_type != 2 {
            cursor.skip(wire_type)?;
            continue;
        }
        let mut stack = ProtoCursor::new(cursor.read_length_delimited()?);
        while !stack.is_finished() {
            let (field, wire_type) = stack.read_key()?;
            if field != 3 || wire_type != 2 {
                stack.skip(wire_type)?;
                continue;
            }
            glyphs.push(parse_glyph(stack.read_length_delimited()?)?);
        }
    }
    Ok(glyphs)
}

fn parse_glyph(bytes: &[u8]) -> Result<Glyph, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut glyph = Glyph {
        id: 0,
        bitmap: Vec::new(),
        metrics: GlyphMetrics::default(),
    };
    let int = |value: u64| u32::try_from(value).map_err(|_| VectorTileError::InvalidProtobuf);
    let sint = |value: u64| ((value >> 1) as i32) ^ -((value & 1) as i32);
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        match (field, wire_type) {
            (1, 0) => glyph.id = int(cursor.read_varint()?)?,
            (2, 2) => glyph.bitmap = cursor.read_length_delimited()?.to_vec(),
            (3, 0) => glyph.metrics.width = int(cursor.read_varint()?)?,
            (4, 0) => glyph.metrics.height = int(cursor.read_varint()?)?,
            (5, 0) => glyph.metrics.left = sint(cursor.read_varint()?),
            (6, 0) => glyph.metrics.top = sint(cursor.read_varint()?),
            (7, 0) => glyph.metrics.advance = int(cursor.read_varint()?)?,
            _ => cursor.skip(wire_type)?,
        }
    }
    let border = 2 * GLYPH_PBF_BORDER as u32;
    let expected =
        (glyph.metrics.width + border) as usize * (glyph.metrics.height + border) as usize;
    if glyph.metrics.width > 0 && glyph.bitmap.len() != expected {
        return Err(VectorTileError::InvalidGeometry);
    }
    Ok(glyph)
}

/// A glyph's bin in the atlas (padding included), in atlas pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AtlasRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Loaded glyphs per font stack, and the ranges requested for each.
#[derive(Default)]
pub struct GlyphStore {
    stacks: BTreeMap<String, BTreeMap<u32, Glyph>>,
    loaded: BTreeSet<(String, u32)>,
    atlas: Option<GlyphAtlas>,
}

impl GlyphStore {
    /// Adds a parsed range for `stack` (the comma-joined `text-font`) starting at `start`.
    pub fn add_range(&mut self, stack: &str, start: u32, glyphs: Vec<Glyph>) {
        let entry = self.stacks.entry(stack.to_owned()).or_default();
        for glyph in glyphs {
            entry.insert(glyph.id, glyph);
        }
        self.loaded.insert((stack.to_owned(), start / 256 * 256));
        self.atlas = None;
    }

    /// Whether the 256-codepoint range holding `codepoint` was loaded (even if empty).
    #[must_use]
    pub fn has_range(&self, stack: &str, codepoint: u32) -> bool {
        self.loaded
            .contains(&(stack.to_owned(), codepoint / 256 * 256))
    }

    #[must_use]
    pub fn glyph(&self, stack: &str, codepoint: u32) -> Option<&Glyph> {
        self.stacks.get(stack)?.get(&codepoint)
    }

    /// The atlas over every loaded glyph; rebuilt after ranges were added.
    pub fn atlas(&mut self) -> &GlyphAtlas {
        self.atlas
            .get_or_insert_with(|| GlyphAtlas::new(&self.stacks))
    }
}

/// One alpha atlas over all loaded glyphs, as MapLibre builds per tile.
#[derive(Clone, Debug, Default)]
pub struct GlyphAtlas {
    pub width: u32,
    pub height: u32,
    pub image: Vec<u8>,
    positions: BTreeMap<(String, u32), AtlasRect>,
    /// Bumped on every rebuild so renderers know to re-upload.
    pub revision: u64,
}

impl GlyphAtlas {
    fn new(stacks: &BTreeMap<String, BTreeMap<u32, Glyph>>) -> Self {
        let mut bins = Vec::new();
        for (stack, glyphs) in stacks {
            for glyph in glyphs.values() {
                if glyph.bitmap.is_empty() {
                    continue;
                }
                let border = 2 * GLYPH_PBF_BORDER as u32;
                bins.push((
                    (stack.clone(), glyph.id),
                    AtlasRect {
                        x: 0,
                        y: 0,
                        w: glyph.metrics.width + border + 2 * ATLAS_PADDING,
                        h: glyph.metrics.height + border + 2 * ATLAS_PADDING,
                    },
                ));
            }
        }
        let mut rects: Vec<AtlasRect> = bins.iter().map(|(_, rect)| *rect).collect();
        let (width, height) = potpack(&mut rects);
        let (width, height) = (width.max(1), height.max(1));
        let mut image = vec![0; width as usize * height as usize];
        let mut positions = BTreeMap::new();
        for ((key, _), rect) in bins.into_iter().zip(rects) {
            let glyph = &stacks[&key.0][&key.1];
            let source_width = (rect.w - 2 * ATLAS_PADDING) as usize;
            for (row, line) in glyph.bitmap.chunks(source_width).enumerate() {
                let start = (rect.y + ATLAS_PADDING) as usize + row;
                let offset = start * width as usize + (rect.x + ATLAS_PADDING) as usize;
                image[offset..offset + source_width].copy_from_slice(line);
            }
            positions.insert(key, rect);
        }
        static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self {
            width,
            height,
            image,
            positions,
            revision: REVISION.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    #[must_use]
    pub fn rect(&self, stack: &str, codepoint: u32) -> Option<AtlasRect> {
        self.positions.get(&(stack.to_owned(), codepoint)).copied()
    }
}

/// `potpack` 2.1: packs boxes (tallest first) into a near-square; returns its size.
fn potpack(boxes: &mut [AtlasRect]) -> (u32, u32) {
    #[derive(Clone, Copy)]
    struct Space {
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    }
    let area: u64 = boxes.iter().map(|b| u64::from(b.w) * u64::from(b.h)).sum();
    let max_width = boxes.iter().map(|b| b.w).max().unwrap_or(0);
    // A stable sort, as JavaScript's `Array.prototype.sort`.
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by(|a, b| boxes[*b].h.cmp(&boxes[*a].h));
    let start_width = ((area as f64 / 0.95).sqrt().ceil() as u32).max(max_width);
    let mut spaces = vec![Space {
        x: 0,
        y: 0,
        w: start_width,
        h: u32::MAX,
    }];
    let (mut width, mut height) = (0, 0);
    for index in order {
        let item = &mut boxes[index];
        for i in (0..spaces.len()).rev() {
            let space = spaces[i];
            if item.w > space.w || item.h > space.h {
                continue;
            }
            item.x = space.x;
            item.y = space.y;
            height = height.max(item.y + item.h);
            width = width.max(item.x + item.w);
            if item.w == space.w && item.h == space.h {
                let last = spaces.pop();
                if let Some(last) = last
                    && i < spaces.len()
                {
                    spaces[i] = last;
                }
            } else if item.h == space.h {
                spaces[i].x += item.w;
                spaces[i].w -= item.w;
            } else if item.w == space.w {
                spaces[i].y += item.h;
                spaces[i].h -= item.h;
            } else {
                spaces.push(Space {
                    x: space.x + item.w,
                    y: space.y,
                    w: space.w - item.w,
                    h: item.h,
                });
                spaces[i].y += item.h;
                spaces[i].h -= item.h;
            }
            break;
        }
    }
    (width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_without_overlap() {
        let mut boxes: Vec<AtlasRect> = (1..20)
            .map(|i| AtlasRect {
                x: 0,
                y: 0,
                w: 5 + i % 7,
                h: 8 + i % 5,
            })
            .collect();
        let (width, height) = potpack(&mut boxes);
        for (i, a) in boxes.iter().enumerate() {
            assert!(a.x + a.w <= width && a.y + a.h <= height);
            for b in &boxes[i + 1..] {
                let disjoint =
                    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
                assert!(disjoint);
            }
        }
    }
}
