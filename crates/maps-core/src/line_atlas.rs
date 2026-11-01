//! MapLibre's dash atlas (`render/line_atlas.ts`, #322): every `line-dasharray` (per round
//! cap or not) becomes rows of a 256 x 512 alpha texture holding a signed distance to the
//! dash edges, which line shaders sample with linear filtering and repeat wrapping.
//!
//! A row stretches one period of the pattern over the texture width; a plain dash is one
//! row, a round-capped one fifteen rows across the line so the dash ends are half discs.

use std::collections::HashMap;

/// MapLibre's `new LineAtlas(256, 512)`.
pub const LINE_ATLAS_WIDTH: u32 = 256;
pub const LINE_ATLAS_HEIGHT: u32 = 512;

/// Where a dash pattern lives: its centre row, its row span (0 for a plain dash, 14 for a
/// round one) and the pattern's period in `line-width` units (the dash array's sum).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DashEntry {
    pub y: f32,
    pub height: f32,
    pub width: f32,
}

#[derive(Clone, Copy, Debug)]
struct DashRange {
    left: f64,
    right: f64,
    is_dash: bool,
    zero_length: bool,
}

/// The dash atlas: an R8 texture plus the entries already written.
#[derive(Clone, Debug)]
pub struct LineAtlas {
    pub data: Vec<u8>,
    next_row: u32,
    entries: HashMap<(Vec<u64>, bool), DashEntry>,
    /// Bumped whenever `data` changes, so renderers know when to upload it again.
    pub version: u32,
}

impl Default for LineAtlas {
    fn default() -> Self {
        Self {
            data: vec![0; (LINE_ATLAS_WIDTH * LINE_ATLAS_HEIGHT) as usize],
            next_row: 0,
            entries: HashMap::new(),
            version: 0,
        }
    }
}

/// Stores `value` as `Uint8Array` does after MapLibre's clamp.
fn byte(value: f64) -> u8 {
    value.clamp(0.0, 255.0) as u8
}

impl LineAtlas {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The entry for `dasharray` (values in `line-width` units), adding it when new. `None`
    /// once the atlas is full, as MapLibre warns "LineAtlas out of space".
    pub fn dash(&mut self, dasharray: &[f64], round: bool) -> Option<DashEntry> {
        let key = (
            dasharray.iter().map(|value| value.to_bits()).collect(),
            round,
        );
        if let Some(entry) = self.entries.get(&key) {
            return Some(*entry);
        }
        let entry = self.add_dash(dasharray, round)?;
        self.entries.insert(key, entry);
        Some(entry)
    }

    fn ranges(dasharray: &[f64], stretch: f64) -> Vec<DashRange> {
        // An odd count joins the last dash to the first.
        let odd = dasharray.len() % 2 == 1;
        let mut ranges = Vec::with_capacity(dasharray.len());
        let left = if odd {
            -dasharray[dasharray.len() - 1] * stretch
        } else {
            0.0
        };
        ranges.push(DashRange {
            left,
            right: dasharray[0] * stretch,
            is_dash: true,
            zero_length: dasharray[0] == 0.0,
        });
        let mut current = dasharray[0];
        let mut is_dash = true;
        for &dash in &dasharray[1..] {
            is_dash = !is_dash;
            let left = current * stretch;
            current += dash;
            ranges.push(DashRange {
                left,
                right: current * stretch,
                is_dash,
                zero_length: dash == 0.0,
            });
        }
        ranges
    }

    fn add_round_dash(&mut self, ranges: &[DashRange], stretch: f64, n: i32) {
        let half_stretch = stretch / 2.0;
        for y in -n..=n {
            let row = self.next_row as i32 + n + y;
            let index = (LINE_ATLAS_WIDTH as i32 * row) as usize;
            let mut current = 0;
            let mut range = ranges[current];
            for x in 0..LINE_ATLAS_WIDTH as usize {
                let xf = x as f64;
                if xf / range.right > 1.0 && current + 1 < ranges.len() {
                    current += 1;
                    range = ranges[current];
                }
                let min_distance = (xf - range.left).abs().min((xf - range.right).abs());
                let middle = f64::from(y) / f64::from(n) * (half_stretch + 1.0);
                let signed = if range.is_dash {
                    let edge = half_stretch - middle.abs();
                    (min_distance * min_distance + edge * edge).sqrt()
                } else {
                    half_stretch - (min_distance * min_distance + middle * middle).sqrt()
                };
                self.data[index + x] = byte(signed + 128.0);
            }
        }
    }

    fn add_regular_dash(&mut self, mut ranges: Vec<DashRange>) {
        // Drop zero-length parts and merge neighbours of the same kind.
        let mut index = ranges.len();
        while index > 0 {
            index -= 1;
            let part = ranges[index];
            if part.zero_length {
                ranges.remove(index);
            } else if let Some(next) = ranges.get_mut(index + 1)
                && next.is_dash == part.is_dash
            {
                next.left = part.left;
                ranges.remove(index);
            }
        }
        if ranges.is_empty() {
            return;
        }
        // Join the first and last parts when they are the same kind.
        let last = ranges.len() - 1;
        if ranges[0].is_dash == ranges[last].is_dash {
            ranges[0].left = ranges[last].left - f64::from(LINE_ATLAS_WIDTH);
            ranges[last].right = ranges[0].right + f64::from(LINE_ATLAS_WIDTH);
        }
        let row = (LINE_ATLAS_WIDTH * self.next_row) as usize;
        let mut current = 0;
        let mut range = ranges[current];
        for x in 0..LINE_ATLAS_WIDTH as usize {
            let xf = x as f64;
            if xf / range.right > 1.0 && current + 1 < ranges.len() {
                current += 1;
                range = ranges[current];
            }
            let min_distance = (xf - range.left).abs().min((xf - range.right).abs());
            let signed = if range.is_dash {
                min_distance
            } else {
                -min_distance
            };
            self.data[row + x] = byte(signed + 128.0);
        }
    }

    fn add_dash(&mut self, dasharray: &[f64], round: bool) -> Option<DashEntry> {
        let n = if round { 7 } else { 0 };
        let height = 2 * n + 1;
        if self.next_row + height > LINE_ATLAS_HEIGHT {
            return None;
        }
        let length: f64 = dasharray.iter().sum();
        if length != 0.0 && !dasharray.is_empty() {
            let stretch = f64::from(LINE_ATLAS_WIDTH) / length;
            let ranges = Self::ranges(dasharray, stretch);
            if round {
                self.add_round_dash(&ranges, stretch, n as i32);
            } else {
                self.add_regular_dash(ranges);
            }
        }
        let entry = DashEntry {
            y: (self.next_row + n) as f32,
            height: (2 * n) as f32,
            width: length as f32,
        };
        self.next_row += height;
        self.version += 1;
        Some(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(atlas: &LineAtlas, entry: DashEntry) -> &[u8] {
        let start = entry.y as usize * LINE_ATLAS_WIDTH as usize;
        &atlas.data[start..start + LINE_ATLAS_WIDTH as usize]
    }

    #[test]
    fn a_plain_dash_is_one_row_of_signed_distances() {
        let mut atlas = LineAtlas::new();
        let entry = atlas.dash(&[3.0, 1.0], false).unwrap();
        assert_eq!(
            entry,
            DashEntry {
                y: 0.0,
                height: 0.0,
                width: 4.0
            }
        );
        let row = row(&atlas, entry);
        // Dash over [0, 192), gap over [192, 256): inside > 128 > outside.
        assert!(row[96] > 200);
        assert_eq!(row[192], 128);
        assert!(row[224] < 128 - 30);
        // The same pattern reuses its row.
        assert_eq!(atlas.dash(&[3.0, 1.0], false), Some(entry));
        assert_eq!(atlas.dash(&[3.0, 1.0], true).unwrap().y, 8.0);
    }

    #[test]
    fn a_zero_gap_is_solid() {
        let mut atlas = LineAtlas::new();
        let entry = atlas.dash(&[1.0, 0.0], false).unwrap();
        assert!(row(&atlas, entry).iter().all(|&value| value == 255));
    }

    #[test]
    fn round_dashes_fill_fifteen_rows_and_run_out_of_space() {
        let mut atlas = LineAtlas::new();
        let entry = atlas.dash(&[0.5, 2.0], true).unwrap();
        assert_eq!((entry.y, entry.height), (7.0, 14.0));
        let mut added = 1;
        while atlas.dash(&[f64::from(added), 1.0], true).is_some() {
            added += 1;
        }
        assert_eq!(added, (LINE_ATLAS_HEIGHT / 15) as i32);
    }
}
