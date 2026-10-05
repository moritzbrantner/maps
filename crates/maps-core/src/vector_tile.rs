//! Maps-owned Mapbox Vector Tile decoding for the Shortbread basemap.
//!
//! This module intentionally owns only the wire/geometry subset required to turn selected
//! Shortbread geometry into geographic coordinates. Styling and pixels remain separate concerns.

use core::fmt;

use serde::Serialize;

use crate::TileId;

const DEFAULT_EXTENT: u32 = 4096;
const MVT_MOVE_TO: u32 = 1;
const MVT_LINE_TO: u32 = 2;
const MVT_CLOSE_PATH: u32 = 7;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VectorBasemapLineKind {
    Coast,
    Water,
    Street,
    Boundary,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VectorBasemapLine<C = [f64; 2]> {
    pub kind: VectorBasemapLineKind,
    pub coordinates: Vec<C>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VectorBasemapPolygonKind {
    Ocean,
    Water,
    Land,
    Site,
    Building,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorBasemapPolygon<C = [f64; 2]> {
    pub kind: VectorBasemapPolygonKind,
    pub source_kind: Option<String>,
    /// One exterior ring followed by its interior rings, all explicitly closed.
    pub rings: Vec<Vec<C>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct VectorBasemapTile<C = [f64; 2]> {
    pub lines: Vec<VectorBasemapLine<C>>,
    pub polygons: Vec<VectorBasemapPolygon<C>>,
}

/// Tile-local pixel position, including buffered geometry outside the tile bounds.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct VectorTilePixel {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VectorTileError {
    InvalidProtobuf,
    InvalidGeometry,
    InvalidUtf8,
    InvalidTileSize,
}

impl fmt::Display for VectorTileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProtobuf => write!(formatter, "invalid MVT protobuf payload"),
            Self::InvalidGeometry => write!(formatter, "invalid MVT geometry command stream"),
            Self::InvalidTileSize => write!(formatter, "tile pixel size must be in 1..=4096"),
            Self::InvalidUtf8 => write!(formatter, "invalid UTF-8 in MVT text"),
        }
    }
}

impl std::error::Error for VectorTileError {}

/// Compatibility view of the Shortbread decoder for line-only consumers.
pub fn decode_shortbread_basemap_lines(
    bytes: &[u8],
    tile: TileId,
) -> Result<Vec<VectorBasemapLine>, VectorTileError> {
    Ok(decode_shortbread_basemap(bytes, tile)?.lines)
}

/// Decodes Shortbread linework and filled polygons, grouping MVT interior rings
/// with their preceding exterior ring before geographic coordinate conversion.
pub fn decode_shortbread_basemap(
    bytes: &[u8],
    tile: TileId,
) -> Result<VectorBasemapTile, VectorTileError> {
    decode_with_coordinates(bytes, |extent, x, y| {
        tile_coordinate_to_lon_lat(tile, extent, x, y)
    })
}

/// Prepares fixed-style tile rendering without materializing geographic coordinates.
/// The same decoder owns feature classification, winding and interior-ring grouping.
pub fn decode_shortbread_tile_pixels(
    bytes: &[u8],
    size: u32,
) -> Result<VectorBasemapTile<VectorTilePixel>, VectorTileError> {
    if !(1..=4096).contains(&size) {
        return Err(VectorTileError::InvalidTileSize);
    }
    decode_with_coordinates(bytes, |extent, x, y| {
        let scale = f64::from(size) / f64::from(extent);
        Ok(VectorTilePixel {
            x: f64::from(x) * scale,
            y: f64::from(y) * scale,
        })
    })
}

fn decode_with_coordinates<C: Clone>(
    bytes: &[u8],
    project: impl Fn(u32, i32, i32) -> Result<C, VectorTileError>,
) -> Result<VectorBasemapTile<C>, VectorTileError> {
    let mut output = VectorBasemapTile {
        lines: Vec::new(),
        polygons: Vec::new(),
    };
    visit_shortbread_features(bytes, |feature| {
        let mut coordinates = Vec::with_capacity(feature.paths.len());
        for path in &feature.paths {
            coordinates.push(
                path.iter()
                    .map(|[x, y]| project(feature.extent, *x, *y))
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        if let Some(kind) = feature.line_kind {
            for path in &feature.line_paths {
                output.lines.push(VectorBasemapLine {
                    kind,
                    coordinates: path
                        .iter()
                        .map(|[x, y]| project(feature.extent, *x, *y))
                        .collect::<Result<Vec<_>, _>>()?,
                });
            }
        }
        if let Some(kind) = feature.polygon_kind {
            output.polygons.extend(feature.polygons.iter().map(|rings| {
                VectorBasemapPolygon {
                    kind,
                    source_kind: feature.source_kind.clone(),
                    rings: rings
                        .iter()
                        .map(|&ring| coordinates[ring].clone())
                        .collect(),
                }
            }));
        }
        Ok(())
    })?;
    Ok(output)
}

/// One accepted Shortbread feature in integer MVT tile coordinates.
pub(crate) struct ShortbreadFeature {
    pub extent: u32,
    /// Set when every path of this feature is also Shortbread linework.
    pub line_kind: Option<VectorBasemapLineKind>,
    /// Set when this feature is a filled Shortbread polygon.
    pub polygon_kind: Option<VectorBasemapPolygonKind>,
    pub source_kind: Option<String>,
    /// Decoded paths with at least two points; polygon rings are explicitly closed.
    pub paths: Vec<Vec<[i32; 2]>>,
    /// Linework of this feature (with `line_kind`): line paths as decoded, or polygon
    /// rings split where they run along the tile clip edge, which is not a real shore.
    pub line_paths: Vec<Vec<[i32; 2]>>,
    /// Polygon path indices grouped as one exterior followed by its interior rings.
    pub polygons: Vec<Vec<usize>>,
}

/// Visits the Shortbread features Maps owns, in protobuf layer and feature order.
pub(crate) fn visit_shortbread_features(
    bytes: &[u8],
    mut visit: impl FnMut(ShortbreadFeature) -> Result<(), VectorTileError>,
) -> Result<(), VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        if field == 3 && wire_type == 2 {
            let layer = cursor.read_length_delimited()?;
            decode_layer(layer, &mut visit)?;
        } else {
            cursor.skip(wire_type)?;
        }
    }
    Ok(())
}

fn decode_layer(
    bytes: &[u8],
    visit: &mut impl FnMut(ShortbreadFeature) -> Result<(), VectorTileError>,
) -> Result<(), VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut name: Option<&str> = None;
    let mut extent = DEFAULT_EXTENT;
    let mut features = Vec::new();
    let mut properties = LayerProperties::default();

    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        match (field, wire_type) {
            (1, 2) => {
                name = Some(
                    core::str::from_utf8(cursor.read_length_delimited()?)
                        .map_err(|_| VectorTileError::InvalidUtf8)?,
                );
            }
            (2, 2) => features.push(cursor.read_length_delimited()?),
            (3, 2) => properties.keys.push(
                core::str::from_utf8(cursor.read_length_delimited()?)
                    .map_err(|_| VectorTileError::InvalidUtf8)?,
            ),
            (4, 2) => properties
                .values
                .push(decode_string_value(cursor.read_length_delimited()?)?),
            (5, 0) => {
                extent = u32::try_from(cursor.read_varint()?)
                    .map_err(|_| VectorTileError::InvalidProtobuf)?;
                if extent == 0 {
                    return Err(VectorTileError::InvalidGeometry);
                }
            }
            _ => cursor.skip(wire_type)?,
        }
    }

    let line_layer = name.and_then(shortbread_line_layer);
    let polygon_kind = name.and_then(shortbread_polygon_layer);
    if line_layer.is_none() && polygon_kind.is_none() {
        return Ok(());
    }

    for feature in features {
        if let Some(feature) =
            decode_feature(feature, extent, line_layer, polygon_kind, &properties)?
        {
            visit(feature)?;
        }
    }

    Ok(())
}

#[derive(Default)]
struct LayerProperties<'a> {
    keys: Vec<&'a str>,
    values: Vec<Option<&'a str>>,
}

impl LayerProperties<'_> {
    fn source_kind(&self, tags: &[u32]) -> Result<Option<String>, VectorTileError> {
        let (pairs, remainder) = tags.as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(VectorTileError::InvalidProtobuf);
        }
        let mut source_kind = None;
        for pair in pairs {
            let key = self
                .keys
                .get(pair[0] as usize)
                .ok_or(VectorTileError::InvalidProtobuf)?;
            let value = self
                .values
                .get(pair[1] as usize)
                .ok_or(VectorTileError::InvalidProtobuf)?;
            if *key == "kind" {
                source_kind = value.map(str::to_owned);
            }
        }
        Ok(source_kind)
    }
}

fn decode_string_value(bytes: &[u8]) -> Result<Option<&str>, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut value = None;
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        if field == 1 && wire_type == 2 {
            value = Some(
                core::str::from_utf8(cursor.read_length_delimited()?)
                    .map_err(|_| VectorTileError::InvalidUtf8)?,
            );
        } else {
            cursor.skip(wire_type)?;
        }
    }
    Ok(value)
}

fn shortbread_polygon_layer(name: &str) -> Option<VectorBasemapPolygonKind> {
    match name {
        "ocean" => Some(VectorBasemapPolygonKind::Ocean),
        "water_polygons" => Some(VectorBasemapPolygonKind::Water),
        "land" => Some(VectorBasemapPolygonKind::Land),
        "sites" => Some(VectorBasemapPolygonKind::Site),
        "buildings" => Some(VectorBasemapPolygonKind::Building),
        _ => None,
    }
}

fn shortbread_line_layer(name: &str) -> Option<(VectorBasemapLineKind, bool)> {
    match name {
        "ocean" => Some((VectorBasemapLineKind::Coast, true)),
        "water_lines" => Some((VectorBasemapLineKind::Water, false)),
        "water_polygons" => Some((VectorBasemapLineKind::Water, true)),
        "streets" => Some((VectorBasemapLineKind::Street, false)),
        "boundaries" => Some((VectorBasemapLineKind::Boundary, false)),
        _ => None,
    }
}

fn decode_feature(
    bytes: &[u8],
    extent: u32,
    line_layer: Option<(VectorBasemapLineKind, bool)>,
    polygon_kind: Option<VectorBasemapPolygonKind>,
    properties: &LayerProperties<'_>,
) -> Result<Option<ShortbreadFeature>, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut geometry_type = 0_u32;
    let mut geometry = Vec::new();
    let mut tags = Vec::new();

    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        match (field, wire_type) {
            (3, 0) => {
                geometry_type = u32::try_from(cursor.read_varint()?)
                    .map_err(|_| VectorTileError::InvalidProtobuf)?;
            }
            (2 | 4, 2) => {
                let target = if field == 2 { &mut tags } else { &mut geometry };
                let mut packed = ProtoCursor::new(cursor.read_length_delimited()?);
                while !packed.is_finished() {
                    target.push(
                        u32::try_from(packed.read_varint()?)
                            .map_err(|_| VectorTileError::InvalidProtobuf)?,
                    );
                }
            }
            (2 | 4, 0) => {
                let target = if field == 2 { &mut tags } else { &mut geometry };
                target.push(
                    u32::try_from(cursor.read_varint()?)
                        .map_err(|_| VectorTileError::InvalidProtobuf)?,
                );
            }
            _ => cursor.skip(wire_type)?,
        }
    }

    let accepts_geometry = (geometry_type == 2 && line_layer.is_some())
        || (geometry_type == 3 && polygon_kind.is_some());
    if !accepts_geometry {
        return Ok(None);
    }
    if geometry.is_empty() {
        return Err(VectorTileError::InvalidGeometry);
    }

    let source_kind = properties.source_kind(&tags)?;
    let mut paths = decode_geometry_paths(&geometry, geometry_type == 3)?;
    paths.retain(|path| path.len() >= 2);
    let line_kind = line_layer
        .filter(|(_, accepts_polygon)| geometry_type == 2 || *accepts_polygon)
        .map(|(kind, _)| kind);
    let polygon_kind = polygon_kind.filter(|_| geometry_type == 3);
    let mut polygons: Vec<Vec<usize>> = Vec::new();
    if polygon_kind.is_some() {
        for (index, path) in paths.iter().enumerate() {
            // MVT uses screen coordinates: positive signed area is an exterior.
            // i128 keeps products and sums exact even for large buffered coordinates.
            let area: i128 = path
                .windows(2)
                .map(|pair| {
                    i128::from(pair[0][0]) * i128::from(pair[1][1])
                        - i128::from(pair[1][0]) * i128::from(pair[0][1])
                })
                .sum();
            match area.signum() {
                1 => polygons.push(vec![index]),
                -1 => polygons
                    .last_mut()
                    .ok_or(VectorTileError::InvalidGeometry)?
                    .push(index),
                _ => return Err(VectorTileError::InvalidGeometry),
            }
        }
    }

    let line_paths = match line_kind {
        None => Vec::new(),
        Some(_) if geometry_type == 2 => paths.clone(),
        Some(_) => paths
            .iter()
            .flat_map(|ring| split_at_tile_edges(ring, extent))
            .collect(),
    };

    Ok(Some(ShortbreadFeature {
        extent,
        line_kind,
        polygon_kind,
        source_kind,
        paths,
        line_paths,
        polygons,
    }))
}

/// Splits a polygon ring into runs that exclude segments lying on or beyond one tile
/// clip edge. Clipped polygons close along the tile (buffer) boundary; outlining those
/// segments would draw tile seams instead of coastlines.
pub(crate) fn split_at_tile_edges(ring: &[[i32; 2]], extent: u32) -> Vec<Vec<[i32; 2]>> {
    let extent = i32::try_from(extent).unwrap_or(i32::MAX);
    let on_clip_edge = |a: [i32; 2], b: [i32; 2]| {
        (a[0] <= 0 && b[0] <= 0)
            || (a[0] >= extent && b[0] >= extent)
            || (a[1] <= 0 && b[1] <= 0)
            || (a[1] >= extent && b[1] >= extent)
    };
    let mut runs = Vec::new();
    let mut current: Vec<[i32; 2]> = Vec::new();
    for pair in ring.windows(2) {
        if on_clip_edge(pair[0], pair[1]) {
            if current.len() >= 2 {
                runs.push(core::mem::take(&mut current));
            }
            current.clear();
            continue;
        }
        if current.is_empty() {
            current.push(pair[0]);
        }
        current.push(pair[1]);
    }
    if current.len() >= 2 {
        runs.push(current);
    }
    // A ring whose first run continues its last run is one line through the start.
    if runs.len() >= 2 && ring.first() == ring.last() {
        let first = &runs[0];
        let last = &runs[runs.len() - 1];
        if first.first() == ring.first() && last.last() == ring.last() {
            let mut joined = runs.pop().unwrap_or_default();
            joined.extend_from_slice(&runs[0][1..]);
            runs[0] = joined;
        }
    }
    runs
}

fn decode_geometry_paths(
    commands: &[u32],
    close_polygons: bool,
) -> Result<Vec<Vec<[i32; 2]>>, VectorTileError> {
    let mut paths = Vec::new();
    let mut current = Vec::new();
    let mut cursor = [0_i32, 0_i32];
    let mut index = 0_usize;

    while index < commands.len() {
        let command = commands[index];
        index += 1;
        let id = command & 0x7;
        let count = command >> 3;
        if count == 0 {
            return Err(VectorTileError::InvalidGeometry);
        }

        match id {
            MVT_MOVE_TO | MVT_LINE_TO => {
                if close_polygons
                    && ((id == MVT_MOVE_TO && (count != 1 || !current.is_empty()))
                        || (id == MVT_LINE_TO && (count < 2 || current.len() != 1)))
                {
                    return Err(VectorTileError::InvalidGeometry);
                }
                if id == MVT_MOVE_TO && !current.is_empty() {
                    paths.push(core::mem::take(&mut current));
                }
                for _ in 0..count {
                    if index + 1 >= commands.len() {
                        return Err(VectorTileError::InvalidGeometry);
                    }
                    let dx = decode_zigzag(commands[index]);
                    let dy = decode_zigzag(commands[index + 1]);
                    index += 2;
                    cursor[0] = cursor[0]
                        .checked_add(dx)
                        .ok_or(VectorTileError::InvalidGeometry)?;
                    cursor[1] = cursor[1]
                        .checked_add(dy)
                        .ok_or(VectorTileError::InvalidGeometry)?;
                    current.push(cursor);
                }
            }
            MVT_CLOSE_PATH => {
                if close_polygons {
                    if count != 1 || current.len() < 3 {
                        return Err(VectorTileError::InvalidGeometry);
                    }
                    if current.first() != current.last() {
                        current.push(current[0]);
                    }
                    paths.push(core::mem::take(&mut current));
                }
            }
            _ => return Err(VectorTileError::InvalidGeometry),
        }
    }

    if !current.is_empty() {
        if close_polygons {
            return Err(VectorTileError::InvalidGeometry);
        }
        paths.push(current);
    }

    Ok(paths)
}

fn decode_zigzag(value: u32) -> i32 {
    ((value >> 1) as i32) ^ -((value & 1) as i32)
}

fn tile_coordinate_to_lon_lat(
    tile: TileId,
    extent: u32,
    x: i32,
    y: i32,
) -> Result<[f64; 2], VectorTileError> {
    let dimension = 2.0_f64.powi(i32::from(tile.z));
    let extent = f64::from(extent);
    let world_x = (f64::from(tile.x) + f64::from(x) / extent) / dimension;
    let world_y = (f64::from(tile.y) + f64::from(y) / extent) / dimension;
    if !world_x.is_finite() || !world_y.is_finite() {
        return Err(VectorTileError::InvalidGeometry);
    }

    let longitude = world_x * 360.0 - 180.0;
    let latitude = (core::f64::consts::PI * (1.0 - 2.0 * world_y))
        .sinh()
        .atan()
        .to_degrees();
    if !longitude.is_finite() || !latitude.is_finite() {
        return Err(VectorTileError::InvalidGeometry);
    }

    Ok([longitude, latitude])
}

struct ProtoCursor<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl<'a> ProtoCursor<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, index: 0 }
    }

    fn is_finished(&self) -> bool {
        self.index >= self.bytes.len()
    }

    fn read_key(&mut self) -> Result<(u32, u8), VectorTileError> {
        let key = self.read_varint()?;
        let field = u32::try_from(key >> 3).map_err(|_| VectorTileError::InvalidProtobuf)?;
        let wire_type = (key & 0x7) as u8;
        if field == 0 {
            return Err(VectorTileError::InvalidProtobuf);
        }
        Ok((field, wire_type))
    }

    fn read_varint(&mut self) -> Result<u64, VectorTileError> {
        let mut value = 0_u64;
        for shift in (0..70).step_by(7) {
            let byte = *self
                .bytes
                .get(self.index)
                .ok_or(VectorTileError::InvalidProtobuf)?;
            self.index += 1;
            if shift == 63 && byte > 1 {
                return Err(VectorTileError::InvalidProtobuf);
            }
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(VectorTileError::InvalidProtobuf)
    }

    fn read_length_delimited(&mut self) -> Result<&'a [u8], VectorTileError> {
        let length =
            usize::try_from(self.read_varint()?).map_err(|_| VectorTileError::InvalidProtobuf)?;
        let end = self
            .index
            .checked_add(length)
            .ok_or(VectorTileError::InvalidProtobuf)?;
        let value = self
            .bytes
            .get(self.index..end)
            .ok_or(VectorTileError::InvalidProtobuf)?;
        self.index = end;
        Ok(value)
    }

    fn skip(&mut self, wire_type: u8) -> Result<(), VectorTileError> {
        match wire_type {
            0 => {
                self.read_varint()?;
            }
            1 => self.skip_bytes(8)?,
            2 => {
                let length = usize::try_from(self.read_varint()?)
                    .map_err(|_| VectorTileError::InvalidProtobuf)?;
                self.skip_bytes(length)?;
            }
            5 => self.skip_bytes(4)?,
            _ => return Err(VectorTileError::InvalidProtobuf),
        }
        Ok(())
    }

    fn skip_bytes(&mut self, count: usize) -> Result<(), VectorTileError> {
        self.index = self
            .index
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(VectorTileError::InvalidProtobuf)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    fn field_varint(field: u32, value: u64) -> Vec<u8> {
        let mut bytes = varint(u64::from(field << 3));
        bytes.extend(varint(value));
        bytes
    }

    fn field_bytes(field: u32, value: &[u8]) -> Vec<u8> {
        let mut bytes = varint(u64::from((field << 3) | 2));
        bytes.extend(varint(value.len() as u64));
        bytes.extend(value);
        bytes
    }

    fn zigzag(value: i32) -> u32 {
        ((value << 1) ^ (value >> 31)) as u32
    }

    fn tiny_line_tile(layer_name: &str, geometry_type: u32, geometry: &[u32]) -> Vec<u8> {
        tiny_tagged_tile(layer_name, geometry_type, geometry, &[])
    }

    fn tiny_tagged_tile(
        layer_name: &str,
        geometry_type: u32,
        geometry: &[u32],
        properties: &[(&str, &str)],
    ) -> Vec<u8> {
        let mut packed_geometry = Vec::new();
        for value in geometry {
            packed_geometry.extend(varint(u64::from(*value)));
        }

        let mut feature = Vec::new();
        let tags = (0..properties.len())
            .flat_map(|index| [index as u64, index as u64])
            .flat_map(varint)
            .collect::<Vec<_>>();
        feature.extend(field_bytes(2, &tags));
        feature.extend(field_varint(3, u64::from(geometry_type)));
        feature.extend(field_bytes(4, &packed_geometry));

        let mut layer = Vec::new();
        layer.extend(field_bytes(1, layer_name.as_bytes()));
        layer.extend(field_bytes(2, &feature));
        for (key, value) in properties {
            layer.extend(field_bytes(3, key.as_bytes()));
            layer.extend(field_bytes(4, &field_bytes(1, value.as_bytes())));
        }
        layer.extend(field_varint(5, 4096));
        layer.extend(field_varint(15, 2));

        field_bytes(3, &layer)
    }

    #[test]
    fn tile_pixels_preserve_holes_and_buffered_coordinates_without_geographic_roundtrips() {
        let geometry = polygon_commands(&[
            &[[-128, -128], [4224, -128], [4224, 4224], [-128, 4224]],
            &[[1024, 1024], [1024, 3072], [3072, 3072], [3072, 1024]],
        ]);
        let bytes = tiny_tagged_tile("water_polygons", 3, &geometry, &[("kind", "glacier")]);
        let pixels = decode_shortbread_tile_pixels(&bytes, 512).unwrap();
        assert_eq!(pixels.polygons.len(), 1);
        assert_eq!(pixels.polygons[0].source_kind.as_deref(), Some("glacier"));
        assert_eq!(pixels.polygons[0].rings.len(), 2);
        assert_eq!(
            pixels.polygons[0].rings[0][0],
            VectorTilePixel { x: -16.0, y: -16.0 }
        );
        assert_eq!(
            pixels.polygons[0].rings[1][0],
            VectorTilePixel { x: 128.0, y: 128.0 }
        );
        // The buffered exterior is the tile clip edge; only the hole's shore is linework.
        assert_eq!(pixels.lines.len(), 1);
        assert!(decode_shortbread_tile_pixels(&bytes, 0).is_err());
        assert!(decode_shortbread_tile_pixels(&bytes, 4097).is_err());
        assert!(decode_shortbread_tile_pixels(&[255], 512).is_err());
    }

    #[test]
    fn preserves_shortbread_kind_for_land_and_water_styling() {
        let geometry = polygon_commands(&[&[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]]);
        for (layer, source_kind) in [("land", "forest"), ("water_polygons", "glacier")] {
            let bytes = tiny_tagged_tile(
                layer,
                3,
                &geometry,
                &[("name", "fixture"), ("kind", source_kind)],
            );
            let tile = decode_shortbread_basemap(&bytes, TileId::new(1, 1, 0).unwrap()).unwrap();
            assert_eq!(tile.polygons[0].source_kind.as_deref(), Some(source_kind));
        }
    }

    #[test]
    fn decodes_water_polygon_with_its_island_hole() {
        let geometry = polygon_commands(&[
            &[[0, 0], [4096, 0], [4096, 4096], [0, 4096]],
            &[[1024, 1024], [1024, 3072], [3072, 3072], [3072, 1024]],
        ]);
        let bytes = tiny_line_tile("water_polygons", 3, &geometry);
        let tile = decode_shortbread_basemap(&bytes, TileId::new(1, 1, 0).unwrap()).unwrap();

        assert_eq!(tile.polygons.len(), 1);
        let polygon = &tile.polygons[0];
        assert_eq!(polygon.kind, VectorBasemapPolygonKind::Water);
        assert_eq!(polygon.rings.len(), 2);
        for ring in &polygon.rings {
            assert_eq!(ring.len(), 5);
            assert_eq!(ring.first(), ring.last());
        }
        assert_eq!(polygon.rings[0][0][0], 0.0);
        assert_eq!(polygon.rings[0][1][0], 180.0);
        assert_eq!(polygon.rings[1][0][0], 45.0);
        // The exterior is the tile clip edge; only the island's shore is linework.
        assert_eq!(tile.lines.len(), 1);
    }

    fn polygon_commands(rings: &[&[[i32; 2]]]) -> Vec<u32> {
        let mut cursor = [0, 0];
        let mut commands = Vec::new();
        for ring in rings {
            for (index, point) in ring.iter().enumerate() {
                if index == 0 {
                    commands.push((1 << 3) | MVT_MOVE_TO);
                } else if index == 1 {
                    commands.push(((ring.len() as u32 - 1) << 3) | MVT_LINE_TO);
                }
                commands.push(zigzag(point[0] - cursor[0]));
                commands.push(zigzag(point[1] - cursor[1]));
                cursor = *point;
            }
            commands.push((1 << 3) | MVT_CLOSE_PATH);
        }
        commands
    }

    #[test]
    fn rejects_incomplete_and_malformed_polygon_command_sequences() {
        let valid = polygon_commands(&[&[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]]);
        let mut repeated_close = valid.clone();
        repeated_close.push(15);
        let mut invalid_close_count = valid.clone();
        *invalid_close_count.last_mut().unwrap() = (2 << 3) | MVT_CLOSE_PATH;
        let malformed = [
            valid[..valid.len() - 1].to_vec(),
            repeated_close,
            invalid_close_count,
            vec![15],
            vec![9, 0, 0, 15],
            vec![10, 0, 0, 15],
            polygon_commands(&[&[[0, 0], [1024, 1024], [2048, 2048]]]),
            polygon_commands(&[&[[1024, 1024], [1024, 3072], [3072, 3072], [3072, 1024]]]),
        ];

        for geometry in malformed {
            let bytes = tiny_line_tile("water_polygons", 3, &geometry);
            assert_eq!(
                decode_shortbread_basemap(&bytes, TileId::new(1, 1, 0).unwrap()),
                Err(VectorTileError::InvalidGeometry),
                "must reject malformed polygon {geometry:?}",
            );
        }
    }

    #[test]
    fn groups_multiple_exteriors_and_their_holes_in_each_supported_polygon_layer() {
        let geometry = polygon_commands(&[
            &[[0, 0], [1024, 0], [1024, 1024], [0, 1024]],
            &[[256, 256], [256, 768], [768, 768], [768, 256]],
            &[[2048, 2048], [4096, 2048], [4096, 4096], [2048, 4096]],
        ]);
        for (layer, kind) in [
            ("ocean", VectorBasemapPolygonKind::Ocean),
            ("water_polygons", VectorBasemapPolygonKind::Water),
            ("land", VectorBasemapPolygonKind::Land),
            ("sites", VectorBasemapPolygonKind::Site),
            ("buildings", VectorBasemapPolygonKind::Building),
        ] {
            let bytes = tiny_line_tile(layer, 3, &geometry);
            let tile = decode_shortbread_basemap(&bytes, TileId::new(1, 1, 0).unwrap()).unwrap();
            assert_eq!(tile.polygons.len(), 2);
            assert_eq!(tile.polygons[0].kind, kind);
            assert_eq!(tile.polygons[0].rings.len(), 2);
            assert_eq!(tile.polygons[1].rings.len(), 1);
            assert_eq!(tile.polygons[1].rings[0][0][0], 90.0);
        }
    }

    #[test]
    fn decodes_shortbread_street_line_to_geographic_coordinates() {
        let geometry = [
            (1 << 3) | MVT_MOVE_TO,
            zigzag(0),
            zigzag(0),
            (1 << 3) | MVT_LINE_TO,
            zigzag(4096),
            zigzag(4096),
        ];
        let bytes = tiny_line_tile("streets", 2, &geometry);
        let lines = decode_shortbread_basemap_lines(&bytes, TileId::new(1, 1, 0).unwrap()).unwrap();

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind, VectorBasemapLineKind::Street);
        assert_eq!(lines[0].coordinates.len(), 2);
        assert!((lines[0].coordinates[0][0] - 0.0).abs() < 1.0e-9);
        assert!((lines[0].coordinates[1][0] - 180.0).abs() < 1.0e-9);
        assert!(lines[0].coordinates[0][1] > 80.0);
        assert!(lines[0].coordinates[1][1].abs() < 1.0e-9);
    }

    #[test]
    fn exposes_ocean_polygon_ring_as_coast_line() {
        let geometry = [
            (1 << 3) | MVT_MOVE_TO,
            zigzag(0),
            zigzag(0),
            (2 << 3) | MVT_LINE_TO,
            zigzag(4096),
            zigzag(0),
            zigzag(0),
            zigzag(4096),
            (1 << 3) | MVT_CLOSE_PATH,
        ];
        let bytes = tiny_line_tile("ocean", 3, &geometry);
        let lines = decode_shortbread_basemap_lines(&bytes, TileId::new(1, 0, 0).unwrap()).unwrap();

        // Only the diagonal is shore; the ring's other sides are the tile clip edge.
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind, VectorBasemapLineKind::Coast);
        assert_eq!(lines[0].coordinates.len(), 2);
        assert_eq!(lines[0].coordinates[0][0], 0.0);
        assert_eq!(lines[0].coordinates[1][0], -180.0);
    }

    #[test]
    fn polygon_outlines_skip_tile_clip_edges_but_keep_interior_rings() {
        // A buffered water body clipped at x = -64 and y = 4160, with an island.
        let ring = [
            [-64, 1000],
            [2000, 800],
            [3000, 2000],
            [2000, 4160],
            [-64, 4160],
            [-64, 1000],
        ];
        assert_eq!(
            split_at_tile_edges(&ring, 4096),
            vec![vec![[-64, 1000], [2000, 800], [3000, 2000], [2000, 4160]]]
        );
        // Starts mid-shore: the run through the closing point is joined.
        let rotated = [
            [2000, 800],
            [3000, 2000],
            [2000, 4160],
            [-64, 4160],
            [-64, 1000],
            [2000, 800],
        ];
        assert_eq!(
            split_at_tile_edges(&rotated, 4096),
            vec![vec![[-64, 1000], [2000, 800], [3000, 2000], [2000, 4160]]]
        );
        let island = [[100, 100], [100, 300], [300, 300], [100, 100]];
        assert_eq!(split_at_tile_edges(&island, 4096), vec![island.to_vec()]);
    }

    #[test]
    fn ignores_unowned_shortbread_layers() {
        let bytes = tiny_line_tile("labels", 2, &[(1 << 3) | MVT_MOVE_TO, 0, 0]);
        let lines = decode_shortbread_basemap_lines(&bytes, TileId::new(0, 0, 0).unwrap()).unwrap();
        assert!(lines.is_empty());
    }
}
