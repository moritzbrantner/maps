//! Generic Mapbox Vector Tile features with their properties, for style layers that read
//! arbitrary source layers (circle and symbol layers). The Shortbread basemap keeps its own
//! class decoder in `vector_tile`.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::vector_tile::{ProtoCursor, VectorTileError, decode_geometry_paths};

/// MVT geometry types (`GeomType` in the specification).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MvtGeometryType {
    Point,
    LineString,
    Polygon,
}

/// One decoded feature in integer tile coordinates of its layer's extent.
#[derive(Clone, Debug, PartialEq)]
pub struct MvtFeature {
    pub id: Option<u64>,
    pub geometry_type: MvtGeometryType,
    /// Points (one path per MoveTo run), line paths, or closed polygon rings.
    pub geometry: Vec<Vec<[i32; 2]>>,
    pub properties: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MvtLayer {
    pub name: String,
    pub extent: u32,
    pub features: Vec<MvtFeature>,
}

/// Decodes the layers whose name `wanted` accepts, in protobuf order.
pub fn decode_mvt_layers(
    bytes: &[u8],
    wanted: impl Fn(&str) -> bool,
) -> Result<Vec<MvtLayer>, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut layers = Vec::new();
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        if field == 3 && wire_type == 2 {
            if let Some(layer) = decode_layer(cursor.read_length_delimited()?, &wanted)? {
                layers.push(layer);
            }
        } else {
            cursor.skip(wire_type)?;
        }
    }
    Ok(layers)
}

fn utf8(bytes: &[u8]) -> Result<&str, VectorTileError> {
    core::str::from_utf8(bytes).map_err(|_| VectorTileError::InvalidUtf8)
}

fn decode_layer(
    bytes: &[u8],
    wanted: &impl Fn(&str) -> bool,
) -> Result<Option<MvtLayer>, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut name = None;
    let mut extent = 4096;
    let mut features = Vec::new();
    let mut keys = Vec::new();
    let mut values = Vec::new();
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        match (field, wire_type) {
            (1, 2) => name = Some(utf8(cursor.read_length_delimited()?)?),
            (2, 2) => features.push(cursor.read_length_delimited()?),
            (3, 2) => keys.push(utf8(cursor.read_length_delimited()?)?),
            (4, 2) => values.push(decode_value(cursor.read_length_delimited()?)?),
            (5, 0) => {
                extent = u32::try_from(cursor.read_varint()?)
                    .ok()
                    .filter(|extent| *extent > 0)
                    .ok_or(VectorTileError::InvalidGeometry)?;
            }
            _ => cursor.skip(wire_type)?,
        }
    }
    let Some(name) = name.filter(|name| wanted(name)) else {
        return Ok(None);
    };
    let features = features
        .into_iter()
        .filter_map(|bytes| decode_feature(bytes, &keys, &values).transpose())
        .collect::<Result<_, _>>()?;
    Ok(Some(MvtLayer {
        name: name.to_owned(),
        extent,
        features,
    }))
}

fn decode_value(bytes: &[u8]) -> Result<Value, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut value = Value::Null;
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        value = match (field, wire_type) {
            (1, 2) => Value::from(utf8(cursor.read_length_delimited()?)?),
            (2, 5) => Value::from(f64::from(f32::from_le_bytes(cursor.read_fixed()?))),
            (3, 1) => Value::from(f64::from_le_bytes(cursor.read_fixed()?)),
            (4, 0) => Value::from(cursor.read_varint()? as i64),
            (5, 0) => Value::from(cursor.read_varint()?),
            (6, 0) => {
                let raw = cursor.read_varint()?;
                Value::from(((raw >> 1) as i64) ^ -((raw & 1) as i64))
            }
            (7, 0) => Value::from(cursor.read_varint()? != 0),
            _ => {
                cursor.skip(wire_type)?;
                continue;
            }
        };
    }
    Ok(value)
}

fn decode_feature(
    bytes: &[u8],
    keys: &[&str],
    values: &[Value],
) -> Result<Option<MvtFeature>, VectorTileError> {
    let mut cursor = ProtoCursor::new(bytes);
    let mut id = None;
    let mut geometry_type = 0;
    let mut tags = Vec::new();
    let mut commands = Vec::new();
    while !cursor.is_finished() {
        let (field, wire_type) = cursor.read_key()?;
        match (field, wire_type) {
            (1, 0) => id = Some(cursor.read_varint()?),
            (3, 0) => geometry_type = cursor.read_varint()?,
            (2 | 4, 2) => {
                let target = if field == 2 { &mut tags } else { &mut commands };
                let mut packed = ProtoCursor::new(cursor.read_length_delimited()?);
                while !packed.is_finished() {
                    target.push(
                        u32::try_from(packed.read_varint()?)
                            .map_err(|_| VectorTileError::InvalidProtobuf)?,
                    );
                }
            }
            _ => cursor.skip(wire_type)?,
        }
    }
    let geometry_type = match geometry_type {
        1 => MvtGeometryType::Point,
        2 => MvtGeometryType::LineString,
        3 => MvtGeometryType::Polygon,
        _ => return Ok(None),
    };
    let geometry = decode_geometry_paths(&commands, geometry_type == MvtGeometryType::Polygon)?;
    let (pairs, remainder) = tags.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err(VectorTileError::InvalidProtobuf);
    }
    let mut properties = BTreeMap::new();
    for [key, value] in pairs {
        let key = keys
            .get(*key as usize)
            .ok_or(VectorTileError::InvalidProtobuf)?;
        let value = values
            .get(*value as usize)
            .ok_or(VectorTileError::InvalidProtobuf)?;
        properties.insert((*key).to_owned(), value.clone());
    }
    Ok(Some(MvtFeature {
        id,
        geometry_type,
        geometry,
        properties,
    }))
}
