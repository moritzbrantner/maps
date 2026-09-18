//! Minimal Maps-owned Mapbox Vector Tile decoding for the first Shortbread basemap slice.
//!
//! This module intentionally owns only the wire/geometry subset required to turn selected
//! Shortbread linework into geographic coordinates. Styling and pixels remain separate concerns.

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
pub struct VectorBasemapLine {
    pub kind: VectorBasemapLineKind,
    pub coordinates: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VectorTileError {
    InvalidProtobuf,
    InvalidGeometry,
    InvalidUtf8,
}

impl fmt::Display for VectorTileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProtobuf => write!(formatter, "invalid MVT protobuf payload"),
            Self::InvalidGeometry => write!(formatter, "invalid MVT geometry command stream"),
            Self::InvalidUtf8 => write!(formatter, "invalid UTF-8 in MVT layer name"),
        }
    }
}

impl std::error::Error for VectorTileError {}

/// Decodes the first Maps-owned Shortbread basemap line vocabulary.
///
/// The first visible slice intentionally keeps the style vocabulary narrow:
/// coast outlines from `ocean`, waterways, streets and administrative boundaries.
/// Polygon filling and the broader style-spec pipeline follow on the same source contract.
pub fn decode_shortbread_basemap_lines(
    bytes: &[u8],
    tile: TileId,
) -> Result<Vec<VectorBasemapLine>, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut lines = Vec::new();

    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        if field == 3 && wire_type == 2 {
            let layer = cursor.read_length_delimited()?;
            decode_layer(layer, tile, &mut lines)?;
        } else {
            cursor.skip(wire_type)?;
        }
    }

    Ok(lines)
}

fn decode_layer(
    bytes: &[u8],
    tile: TileId,
    output: &mut Vec<VectorBasemapLine>,
) -> Result<(), VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut name: Option<&str> = None;
    let mut extent = DEFAULT_EXTENT;
    let mut features = Vec::new();

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

    let Some((kind, accepts_polygon)) = name.and_then(shortbread_line_layer) else {
        return Ok(());
    };

    for feature in features {
        decode_feature(feature, tile, extent, kind, accepts_polygon, output)?;
    }

    Ok(())
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
    tile: TileId,
    extent: u32,
    kind: VectorBasemapLineKind,
    accepts_polygon: bool,
    output: &mut Vec<VectorBasemapLine>,
) -> Result<(), VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut geometry_type = 0_u32;
    let mut geometry = Vec::new();

    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        match (field, wire_type) {
            (3, 0) => {
                geometry_type = u32::try_from(cursor.read_varint()?)
                    .map_err(|_| VectorTileError::InvalidProtobuf)?;
            }
            (4, 2) => {
                let mut packed = ProtoCursor::new(cursor.read_length_delimited()?);
                while !packed.is_finished() {
                    geometry.push(
                        u32::try_from(packed.read_varint()?)
                            .map_err(|_| VectorTileError::InvalidProtobuf)?,
                    );
                }
            }
            (4, 0) => geometry.push(
                u32::try_from(cursor.read_varint()?)
                    .map_err(|_| VectorTileError::InvalidProtobuf)?,
            ),
            _ => cursor.skip(wire_type)?,
        }
    }

    let accepts_geometry = geometry_type == 2 || (accepts_polygon && geometry_type == 3);
    if !accepts_geometry || geometry.is_empty() {
        return Ok(());
    }

    for path in decode_geometry_paths(&geometry, geometry_type == 3)? {
        if path.len() < 2 {
            continue;
        }
        let coordinates = path
            .into_iter()
            .map(|[x, y]| tile_coordinate_to_lon_lat(tile, extent, x, y))
            .collect::<Result<Vec<_>, _>>()?;
        output.push(VectorBasemapLine { kind, coordinates });
    }

    Ok(())
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
                if close_polygons && !current.is_empty() && current.first() != current.last() {
                    current.push(current[0]);
                }
            }
            _ => return Err(VectorTileError::InvalidGeometry),
        }
    }

    if !current.is_empty() {
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
        let mut packed_geometry = Vec::new();
        for value in geometry {
            packed_geometry.extend(varint(u64::from(*value)));
        }

        let mut feature = Vec::new();
        feature.extend(field_varint(3, u64::from(geometry_type)));
        feature.extend(field_bytes(4, &packed_geometry));

        let mut layer = Vec::new();
        layer.extend(field_bytes(1, layer_name.as_bytes()));
        layer.extend(field_bytes(2, &feature));
        layer.extend(field_varint(5, 4096));
        layer.extend(field_varint(15, 2));

        field_bytes(3, &layer)
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

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind, VectorBasemapLineKind::Coast);
        assert_eq!(lines[0].coordinates.first(), lines[0].coordinates.last());
    }

    #[test]
    fn ignores_unowned_shortbread_layers() {
        let bytes = tiny_line_tile("labels", 2, &[(1 << 3) | MVT_MOVE_TO, 0, 0]);
        let lines = decode_shortbread_basemap_lines(&bytes, TileId::new(0, 0, 0).unwrap()).unwrap();
        assert!(lines.is_empty());
    }
}
