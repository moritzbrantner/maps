//! Minimal MVT writer for tests; independent of the decoder under test, so a test states
//! its expected result by construction.

pub(crate) fn varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

pub(crate) fn field(number: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    varint(number << 3 | 2, &mut out);
    varint(payload.len() as u64, &mut out);
    out.extend_from_slice(payload);
    out
}

pub(crate) fn scalar(number: u64, value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    varint(number << 3, &mut out);
    varint(value, &mut out);
    out
}

pub(crate) fn feature(
    id: Option<u64>,
    geometry_type: u64,
    commands: &[u32],
    tags: &[u32],
) -> Vec<u8> {
    let packed = |values: &[u32]| {
        let mut out = Vec::new();
        for value in values {
            varint(u64::from(*value), &mut out);
        }
        out
    };
    let mut out = Vec::new();
    if let Some(id) = id {
        out.extend(scalar(1, id));
    }
    out.extend(field(2, &packed(tags)));
    out.extend(scalar(3, geometry_type));
    out.extend(field(4, &packed(commands)));
    out
}

/// One `layers` entry (field 3 of a tile) with string values and extent 4096.
pub(crate) fn layer(name: &str, features: &[Vec<u8>], keys: &[&str], values: &[&str]) -> Vec<u8> {
    layer_with_extent(name, features, keys, values, 4096)
}

pub(crate) fn layer_with_extent(
    name: &str,
    features: &[Vec<u8>],
    keys: &[&str],
    values: &[&str],
    extent: u64,
) -> Vec<u8> {
    let mut out = field(1, name.as_bytes());
    for feature in features {
        out.extend(field(2, feature));
    }
    for key in keys {
        out.extend(field(3, key.as_bytes()));
    }
    for value in values {
        out.extend(field(4, &field(1, value.as_bytes())));
    }
    out.extend(scalar(5, extent));
    field(3, &out)
}

/// Command integers for absolute paths: MoveTo, LineTo and, when `closed`, ClosePath per path.
/// Polygon rings omit the repeated first vertex.
pub(crate) fn path_commands(paths: &[&[[i32; 2]]], closed: bool) -> Vec<u32> {
    let zigzag = |value: i32| ((value << 1) ^ (value >> 31)) as u32;
    let mut commands = Vec::new();
    let mut cursor = [0, 0];
    for points in paths {
        for (index, point) in points.iter().enumerate() {
            if index == 0 {
                commands.push(9);
            } else if index == 1 {
                commands.push((((points.len() - 1) as u32) << 3) | 2);
            }
            commands.push(zigzag(point[0] - cursor[0]));
            commands.push(zigzag(point[1] - cursor[1]));
            cursor = *point;
        }
        if closed {
            commands.push(15);
        }
    }
    commands
}
