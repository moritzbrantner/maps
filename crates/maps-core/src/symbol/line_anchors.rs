//! Line label anchors (#346), ported from MapLibre 6.15 `clip_line.ts` (`clipLine`),
//! `get_anchors.ts`, `check_max_angle.ts` and `merge_lines.ts`, in 8192-unit tile space.

use std::collections::HashMap;
use std::f64::consts::PI;

use super::expression::js_round;

type Point = [f64; 2];

fn dist(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// `Point.angleTo`: the angle of `a - b`.
fn angle_to(a: Point, b: Point) -> f64 {
    (a[1] - b[1]).atan2(a[0] - b[0])
}

fn round(point: Point) -> Point {
    [js_round(point[0]), js_round(point[1])]
}

/// A label anchor on a line: between `line[segment]` and `line[segment + 1]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineAnchor {
    pub point: Point,
    pub angle: f64,
    pub segment: usize,
}

/// `clipLine`: the parts of `lines` inside `[x1, x2) x [y1, y2)`, cut points rounded.
#[must_use]
pub fn clip_line(lines: &[Vec<Point>], x1: f64, y1: f64, x2: f64, y2: f64) -> Vec<Vec<Point>> {
    let mut clipped: Vec<Vec<Point>> = Vec::new();
    for line in lines {
        let mut current: Option<usize> = None;
        for pair in line.windows(2) {
            let (mut p0, mut p1) = (pair[0], pair[1]);
            let at_x = |p0: Point, p1: Point, x: f64| {
                round([x, p0[1] + (p1[1] - p0[1]) * ((x - p0[0]) / (p1[0] - p0[0]))])
            };
            let at_y = |p0: Point, p1: Point, y: f64| {
                round([p0[0] + (p1[0] - p0[0]) * ((y - p0[1]) / (p1[1] - p0[1])), y])
            };
            if p0[0] < x1 && p1[0] < x1 {
                continue;
            } else if p0[0] < x1 {
                p0 = at_x(p0, p1, x1);
            } else if p1[0] < x1 {
                p1 = at_x(p0, p1, x1);
            }
            if p0[1] < y1 && p1[1] < y1 {
                continue;
            } else if p0[1] < y1 {
                p0 = at_y(p0, p1, y1);
            } else if p1[1] < y1 {
                p1 = at_y(p0, p1, y1);
            }
            if p0[0] >= x2 && p1[0] >= x2 {
                continue;
            } else if p0[0] >= x2 {
                p0 = at_x(p0, p1, x2);
            } else if p1[0] >= x2 {
                p1 = at_x(p0, p1, x2);
            }
            if p0[1] >= y2 && p1[1] >= y2 {
                continue;
            } else if p0[1] >= y2 {
                p0 = at_y(p0, p1, y2);
            } else if p1[1] >= y2 {
                p1 = at_y(p0, p1, y2);
            }
            match current.and_then(|index: usize| clipped.get_mut(index)) {
                Some(last) if last.last() == Some(&p0) => last.push(p1),
                _ => {
                    current = Some(clipped.len());
                    clipped.push(vec![p0, p1]);
                }
            }
        }
    }
    clipped
}

fn line_length(line: &[Point]) -> f64 {
    line.windows(2).map(|pair| dist(pair[0], pair[1])).sum()
}

/// `checkMaxAngle`: whether no `window_size` stretch of the label's part of the line turns by
/// more than `max_angle` in total.
#[must_use]
pub fn check_max_angle(
    line: &[Point],
    anchor: &LineAnchor,
    label_length: f64,
    window_size: f64,
    max_angle: f64,
) -> bool {
    if label_length == 0.0 {
        return true;
    }
    let mut p = anchor.point;
    let mut index = anchor.segment as isize + 1;
    let mut anchor_distance = 0.0;
    // Back to the first segment the label covers.
    while anchor_distance > -label_length / 2.0 {
        index -= 1;
        if index < 0 {
            return false;
        }
        anchor_distance -= dist(line[index as usize], p);
        p = line[index as usize];
    }
    let mut index = index as usize;
    anchor_distance += dist(line[index], line[index + 1]);
    index += 1;
    let mut recent: std::collections::VecDeque<(f64, f64)> = std::collections::VecDeque::new();
    let mut recent_angle_delta = 0.0;
    while anchor_distance < label_length / 2.0 {
        let (prev, current) = (line[index - 1], line[index]);
        let Some(&next) = line.get(index + 1) else {
            return false;
        };
        let angle_delta = angle_to(prev, current) - angle_to(current, next);
        let angle_delta = ((angle_delta + 3.0 * PI).rem_euclid(PI * 2.0) - PI).abs();
        recent.push_back((anchor_distance, angle_delta));
        recent_angle_delta += angle_delta;
        while let Some(&(distance, delta)) = recent.front() {
            if anchor_distance - distance > window_size {
                recent_angle_delta -= delta;
                recent.pop_front();
            } else {
                break;
            }
        }
        if recent_angle_delta > max_angle {
            return false;
        }
        index += 1;
        anchor_distance += dist(current, next);
    }
    true
}

/// The text extent a line label needs (`shapedText.right - left`, glyph units) and the scale
/// to tile units.
#[derive(Clone, Copy, Debug)]
pub struct LabelExtent {
    pub length: f64,
    pub glyph_size: f64,
    pub box_scale: f64,
}

impl LabelExtent {
    fn angle_window(&self) -> f64 {
        3.0 / 5.0 * self.glyph_size * self.box_scale
    }
}

/// `getCenterAnchor` (`symbol-placement: line-center`).
#[must_use]
pub fn center_anchor(line: &[Point], max_angle: f64, extent: &LabelExtent) -> Option<LineAnchor> {
    let window = extent.angle_window();
    let label_length = extent.length * extent.box_scale;
    let center = line_length(line) / 2.0;
    let mut prev = 0.0;
    for (index, pair) in line.windows(2).enumerate() {
        let (a, b) = (pair[0], pair[1]);
        let segment = dist(a, b);
        if prev + segment > center {
            let t = (center - prev) / segment;
            let anchor = LineAnchor {
                point: round([a[0] * (1.0 - t) + b[0] * t, a[1] * (1.0 - t) + b[1] * t]),
                angle: angle_to(b, a),
                segment: index,
            };
            return (window == 0.0
                || check_max_angle(line, &anchor, label_length, window, max_angle))
            .then_some(anchor);
        }
        prev += segment;
    }
    None
}

/// `getAnchors` (`symbol-placement: line`): anchors every `spacing` tile units, the first
/// offset so labels of continued lines line up across tiles.
#[must_use]
pub fn line_anchors(
    line: &[Point],
    spacing: f64,
    max_angle: f64,
    extent: &LabelExtent,
    overscaling: f64,
    tile_extent: f64,
) -> Vec<LineAnchor> {
    let window = extent.angle_window();
    let label_length = extent.length * extent.box_scale;
    let continued =
        |p: Point| p[0] == 0.0 || p[0] == tile_extent || p[1] == 0.0 || p[1] == tile_extent;
    let is_continued = line.first().is_some_and(|p| continued(*p));
    let mut spacing = spacing;
    if spacing - label_length < spacing / 4.0 {
        spacing = label_length + spacing / 4.0;
    }
    let fixed_extra_offset = extent.glyph_size * 2.0;
    let offset = if is_continued {
        (spacing / 2.0 * overscaling) % spacing
    } else {
        ((extent.length / 2.0 + fixed_extra_offset) * extent.box_scale * overscaling) % spacing
    };
    resample(
        line,
        offset,
        spacing,
        window,
        max_angle,
        label_length,
        is_continued,
        false,
        tile_extent,
    )
}

#[allow(clippy::too_many_arguments)]
fn resample(
    line: &[Point],
    offset: f64,
    spacing: f64,
    window: f64,
    max_angle: f64,
    label_length: f64,
    is_continued: bool,
    place_at_middle: bool,
    tile_extent: f64,
) -> Vec<LineAnchor> {
    let half = label_length / 2.0;
    let length = line_length(line);
    let mut distance = 0.0;
    let mut marked = offset - spacing;
    let mut anchors = Vec::new();
    for (index, pair) in line.windows(2).enumerate() {
        let (a, b) = (pair[0], pair[1]);
        let segment = dist(a, b);
        let angle = angle_to(b, a);
        while marked + spacing < distance + segment {
            marked += spacing;
            let t = (marked - distance) / segment;
            let (x, y) = (a[0] * (1.0 - t) + b[0] * t, a[1] * (1.0 - t) + b[1] * t);
            if x >= 0.0
                && x < tile_extent
                && y >= 0.0
                && y < tile_extent
                && marked - half >= 0.0
                && marked + half <= length
            {
                let anchor = LineAnchor {
                    point: round([x, y]),
                    angle,
                    segment: index,
                };
                if window == 0.0 || check_max_angle(line, &anchor, label_length, window, max_angle)
                {
                    anchors.push(anchor);
                }
            }
        }
        distance += segment;
    }
    if !place_at_middle && anchors.is_empty() && !is_continued {
        // Short lines: one more try with a single anchor in the middle.
        anchors = resample(
            line,
            distance / 2.0,
            spacing,
            window,
            max_angle,
            label_length,
            is_continued,
            true,
            tile_extent,
        );
    }
    anchors
}

/// `mergeLines`: features (text, lines) whose first line continues another one with the same
/// text at an end become one line, so labels see the longer line. Returns the surviving
/// features with their (possibly merged) geometry, in MapLibre's order.
#[must_use]
pub fn merge_lines<T>(
    features: Vec<(T, Option<String>, Vec<Vec<Point>>)>,
) -> Vec<(T, Vec<Vec<Point>>)> {
    struct Merged<T> {
        feature: T,
        geometry: Option<Vec<Vec<Point>>>,
        /// The chunks of the first line, in order.
        chunks: Vec<Vec<Point>>,
    }
    let key = |text: &str, point: Point| format!("{text}:{}:{}", point[0], point[1]);
    let mut left: HashMap<String, usize> = HashMap::new();
    let mut right: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<Merged<T>> = Vec::new();
    for (feature, text, geometry) in features {
        let first = geometry.first().cloned().unwrap_or_default();
        let line = Merged {
            feature,
            geometry: Some(geometry),
            chunks: vec![first.clone()],
        };
        let (Some(text), Some(&start), Some(&end)) = (text, first.first(), first.last()) else {
            merged.push(line);
            continue;
        };
        let left_key = key(&text, start);
        let right_key = key(&text, end);
        let from_right = right.get(&left_key).copied();
        let from_left = left.get(&right_key).copied();
        match (from_right, from_left) {
            (Some(i), Some(j)) if i != j => {
                // Lines with the same text at both ends: merge all three into `i`.
                left.remove(&right_key);
                let mut chunks = line.chunks;
                chunks.append(&mut merged[j].chunks);
                merged[j].geometry = None;
                right.remove(&left_key);
                merged[i].chunks.append(&mut chunks);
                let tail = *merged[i]
                    .chunks
                    .last()
                    .and_then(|chunk| chunk.last())
                    .unwrap_or(&end);
                // `mergeFromLeft` re-keyed `j`'s start, then `mergeFromRight` re-keyed `i`'s end.
                left.insert(left_key.clone(), j);
                left.remove(&left_key);
                right.remove(&key(&text, end));
                right.insert(key(&text, tail), i);
            }
            (Some(i), _) => {
                right.remove(&left_key);
                right.insert(right_key, i);
                let mut chunks = line.chunks;
                merged[i].chunks.append(&mut chunks);
            }
            (None, Some(j)) => {
                left.remove(&right_key);
                left.insert(left_key, j);
                let mut chunks = line.chunks;
                chunks.append(&mut merged[j].chunks);
                merged[j].chunks = chunks;
            }
            _ => {
                let index = merged.len();
                merged.push(line);
                left.insert(left_key, index);
                right.insert(right_key, index);
            }
        }
    }
    merged
        .into_iter()
        .filter_map(|line| {
            let mut geometry = line.geometry?;
            if line.chunks.len() > 1 {
                let mut joined = line.chunks[0].clone();
                for chunk in &line.chunks[1..] {
                    joined.extend_from_slice(&chunk[1.min(chunk.len())..]);
                }
                geometry[0] = joined;
            }
            Some((line.feature, geometry))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_lines_to_the_tile_with_rounded_cuts() {
        let lines = vec![vec![[-10.0, 5.0], [10.0, 6.0], [30.0, 6.0]]];
        assert_eq!(
            clip_line(&lines, 0.0, 0.0, 20.0, 20.0),
            vec![vec![[0.0, 6.0], [10.0, 6.0], [20.0, 6.0]]]
        );
    }

    #[test]
    fn anchors_space_along_long_lines_and_fall_back_to_the_middle() {
        let line = vec![[100.0, 4000.0], [8000.0, 4000.0]];
        let extent = LabelExtent {
            length: 60.0,
            glyph_size: 24.0,
            box_scale: 16.0 * 16.0 / 24.0,
        };
        let anchors = line_anchors(&line, 4000.0, 45f64.to_radians(), &extent, 1.0, 8192.0);
        assert_eq!(anchors.len(), 2);
        assert_eq!(
            anchors[0].point,
            [100.0 + (30.0 + 48.0) * 16.0 * 16.0 / 24.0, 4000.0]
        );
        assert_eq!(anchors[0].segment, 0);
        // A sharp corner under the label fails the angle check.
        let corner = vec![[1000.0, 1000.0], [1500.0, 1000.0], [1000.0, 1100.0]];
        assert!(center_anchor(&corner, 45f64.to_radians(), &extent).is_none());
    }

    #[test]
    fn merges_lines_with_the_same_text_end_to_start() {
        let merged = merge_lines(vec![
            (0, Some("A".to_owned()), vec![vec![[0.0, 0.0], [1.0, 0.0]]]),
            (1, Some("A".to_owned()), vec![vec![[2.0, 0.0], [3.0, 0.0]]]),
            (2, Some("A".to_owned()), vec![vec![[1.0, 0.0], [2.0, 0.0]]]),
            (3, Some("B".to_owned()), vec![vec![[3.0, 0.0], [4.0, 0.0]]]),
        ]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].0, 0);
        assert_eq!(
            merged[0].1[0],
            vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]]
        );
        assert_eq!(merged[1].0, 3);
    }
}
