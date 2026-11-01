//! The MapLibre style-expression subset Maps' tileset style layers evaluate: feature data
//! (`get`, `has`, `id`, `geometry-type`), `zoom`, decisions (`match`, `case`, `coalesce`,
//! comparisons, `all`/`any`/`!`), ramps (`interpolate` linear/exponential, `step`), string and
//! math operators, plus legacy `["==", key, value]` filters. Anything else is an explicit error.

use std::collections::BTreeMap;

use serde_json::Value;

use super::color::Rgba;

/// What an expression reads: the feature and the zoom it is evaluated at.
pub struct EvaluationContext<'a> {
    pub zoom: f64,
    pub properties: &'a BTreeMap<String, Value>,
    pub id: Option<u64>,
    /// `Point`, `LineString` or `Polygon`.
    pub geometry_type: &'static str,
}

const OPERATORS: &[&str] = &[
    "get",
    "has",
    "!has",
    "id",
    "geometry-type",
    "zoom",
    "literal",
    "match",
    "case",
    "coalesce",
    "==",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "all",
    "any",
    "!",
    "none",
    "in",
    "!in",
    "interpolate",
    "step",
    "to-string",
    "to-number",
    "to-boolean",
    "string",
    "number",
    "boolean",
    "concat",
    "upcase",
    "downcase",
    "+",
    "-",
    "*",
    "/",
    "%",
    "^",
    "min",
    "max",
    "abs",
    "round",
    "floor",
    "ceil",
    "properties",
    "to-color",
];

/// Whether a style value is an expression rather than a literal (`["NotoSans-Regular"]`
/// or `[0.6, 0]` are literals: their first element names no operator).
#[must_use]
pub fn is_expression(value: &Value) -> bool {
    matches!(value, Value::Array(items) if items.first().and_then(Value::as_str).is_some_and(|op| OPERATORS.contains(&op)))
}

/// Whether the value depends on `zoom` (a camera or composite function).
#[must_use]
pub fn uses_zoom(value: &Value) -> bool {
    match value {
        Value::Array(items) => {
            items.first().and_then(Value::as_str) == Some("zoom") || items.iter().any(uses_zoom)
        }
        _ => false,
    }
}

/// Evaluates a style value: literals are returned as they are.
pub fn evaluate(value: &Value, context: &EvaluationContext<'_>) -> Result<Value, String> {
    let Value::Array(items) = value else {
        return Ok(value.clone());
    };
    if !is_expression(value) {
        return Ok(value.clone());
    }
    let op = items[0].as_str().unwrap_or_default();
    let args = &items[1..];
    let arg = |index: usize| -> Result<Value, String> {
        evaluate(
            args.get(index)
                .ok_or_else(|| format!("`{op}` is missing an argument"))?,
            context,
        )
    };
    let number = |index: usize| -> Result<f64, String> {
        arg(index)?
            .as_f64()
            .ok_or_else(|| format!("`{op}` expects a number"))
    };
    match op {
        "zoom" => Ok(Value::from(context.zoom)),
        "id" => Ok(context.id.map_or(Value::Null, Value::from)),
        "geometry-type" => Ok(Value::from(context.geometry_type)),
        "properties" => Ok(Value::Object(
            context
                .properties
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        )),
        "literal" => Ok(args.first().cloned().unwrap_or(Value::Null)),
        "get" => {
            let key = arg(0)?;
            Ok(key
                .as_str()
                .and_then(|key| context.properties.get(key))
                .cloned()
                .unwrap_or(Value::Null))
        }
        "has" | "!has" => {
            let key = legacy_key(args.first())?;
            let has = match key.as_str() {
                "$type" => true,
                "$id" => context.id.is_some(),
                key => context.properties.contains_key(key),
            };
            Ok(Value::from(has == (op == "has")))
        }
        "==" | "!=" | "<" | "<=" | ">" | ">=" => {
            let (left, right) = if matches!(args.first(), Some(Value::String(_))) && args.len() == 2
            {
                // Legacy filter: ["==", key, value].
                (
                    legacy_property(&legacy_key(args.first())?, context),
                    args[1].clone(),
                )
            } else {
                (arg(0)?, arg(1)?)
            };
            Ok(Value::from(compare(op, &left, &right)))
        }
        "in" | "!in" => {
            let found = if matches!(args.first(), Some(Value::String(_))) {
                let value = legacy_property(&legacy_key(args.first())?, context);
                args[1..].iter().any(|candidate| equal(candidate, &value))
            } else {
                let needle = arg(0)?;
                match arg(1)? {
                    Value::Array(haystack) => haystack.iter().any(|item| equal(item, &needle)),
                    Value::String(haystack) => {
                        needle.as_str().is_some_and(|n| haystack.contains(n))
                    }
                    _ => false,
                }
            };
            Ok(Value::from(found == (op == "in")))
        }
        "all" => {
            for index in 0..args.len() {
                if !truthy(&arg(index)?) {
                    return Ok(Value::from(false));
                }
            }
            Ok(Value::from(true))
        }
        "any" => {
            for index in 0..args.len() {
                if truthy(&arg(index)?) {
                    return Ok(Value::from(true));
                }
            }
            Ok(Value::from(false))
        }
        "none" => {
            for index in 0..args.len() {
                if truthy(&arg(index)?) {
                    return Ok(Value::from(false));
                }
            }
            Ok(Value::from(true))
        }
        "!" => Ok(Value::from(!truthy(&arg(0)?))),
        "match" => {
            let input = arg(0)?;
            let branches = &args[1..];
            if branches.len() < 3 || branches.len().is_multiple_of(2) {
                return Err("`match` needs label/output pairs and a fallback".into());
            }
            for pair in branches[..branches.len() - 1].chunks(2) {
                let hit = match &pair[0] {
                    Value::Array(labels) => labels.iter().any(|label| equal(label, &input)),
                    label => equal(label, &input),
                };
                if hit {
                    return evaluate(&pair[1], context);
                }
            }
            evaluate(&branches[branches.len() - 1], context)
        }
        "case" => {
            if args.len() < 3 || args.len().is_multiple_of(2) {
                return Err("`case` needs condition/output pairs and a fallback".into());
            }
            for pair in args[..args.len() - 1].chunks(2) {
                if truthy(&evaluate(&pair[0], context)?) {
                    return evaluate(&pair[1], context);
                }
            }
            evaluate(&args[args.len() - 1], context)
        }
        "coalesce" => {
            for index in 0..args.len() {
                let value = arg(index)?;
                if !value.is_null() {
                    return Ok(value);
                }
            }
            Ok(Value::Null)
        }
        "interpolate" => interpolate(args, context),
        "step" => {
            let input = number(0)?;
            if args.len() < 2 || !args.len().is_multiple_of(2) {
                return Err("`step` needs a base output and stop/output pairs".into());
            }
            let mut output = &args[1];
            for pair in args[2..].chunks(2) {
                let stop = pair[0].as_f64().ok_or("`step` stops must be numbers")?;
                if input >= stop {
                    output = &pair[1];
                } else {
                    break;
                }
            }
            evaluate(output, context)
        }
        "to-string" => Ok(Value::from(to_string(&arg(0)?))),
        "to-number" => {
            for index in 0..args.len() {
                let value = arg(index)?;
                let number = match &value {
                    Value::Number(number) => number.as_f64(),
                    Value::String(text) => text.trim().parse::<f64>().ok(),
                    Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
                    Value::Null => Some(0.0),
                    _ => None,
                };
                if let Some(number) = number {
                    return Ok(Value::from(number));
                }
            }
            Err("`to-number` could not convert its input".into())
        }
        "to-boolean" => Ok(Value::from(truthy(&arg(0)?))),
        "string" | "number" | "boolean" => {
            for index in 0..args.len() {
                let value = arg(index)?;
                let matches = match op {
                    "string" => value.is_string(),
                    "number" => value.is_number(),
                    _ => value.is_boolean(),
                };
                if matches {
                    return Ok(value);
                }
            }
            Err(format!("`{op}` assertion failed"))
        }
        "to-color" => Ok(arg(0)?),
        "concat" => {
            let mut text = String::new();
            for index in 0..args.len() {
                text.push_str(&to_string(&arg(index)?));
            }
            Ok(Value::from(text))
        }
        "upcase" => Ok(Value::from(to_string(&arg(0)?).to_uppercase())),
        "downcase" => Ok(Value::from(to_string(&arg(0)?).to_lowercase())),
        "+" | "*" | "min" | "max" => {
            let mut total = number(0)?;
            for index in 1..args.len() {
                let value = number(index)?;
                total = match op {
                    "+" => total + value,
                    "*" => total * value,
                    "min" => total.min(value),
                    _ => total.max(value),
                };
            }
            Ok(Value::from(total))
        }
        "-" if args.len() == 1 => Ok(Value::from(-number(0)?)),
        "-" => Ok(Value::from(number(0)? - number(1)?)),
        "/" => Ok(Value::from(number(0)? / number(1)?)),
        "%" => Ok(Value::from(number(0)? % number(1)?)),
        "^" => Ok(Value::from(number(0)?.powf(number(1)?))),
        "abs" => Ok(Value::from(number(0)?.abs())),
        "round" => Ok(Value::from(js_round(number(0)?))),
        "floor" => Ok(Value::from(number(0)?.floor())),
        "ceil" => Ok(Value::from(number(0)?.ceil())),
        _ => Err(format!("unsupported expression operator `{op}`")),
    }
}

fn legacy_key(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::String(key)) => Ok(key.clone()),
        _ => Err("legacy filters name a property key".into()),
    }
}

fn legacy_property(key: &str, context: &EvaluationContext<'_>) -> Value {
    match key {
        "$type" => Value::from(context.geometry_type),
        "$id" => context.id.map_or(Value::Null, Value::from),
        key => context.properties.get(key).cloned().unwrap_or(Value::Null),
    }
}

/// JavaScript `Math.round`: halves round towards positive infinity.
#[must_use]
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn truthy(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}

fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => left == right,
    }
}

fn compare(op: &str, left: &Value, right: &Value) -> bool {
    match op {
        "==" => equal(left, right),
        "!=" => !equal(left, right),
        _ => {
            let ordering = match (left, right) {
                (Value::Number(left), Value::Number(right)) => {
                    left.as_f64().partial_cmp(&right.as_f64())
                }
                (Value::String(left), Value::String(right)) => Some(left.cmp(right)),
                _ => None,
            };
            ordering.is_some_and(|ordering| match op {
                "<" => ordering.is_lt(),
                "<=" => ordering.is_le(),
                ">" => ordering.is_gt(),
                _ => ordering.is_ge(),
            })
        }
    }
}

/// MapLibre's `to-string`: numbers print like JavaScript.
#[must_use]
pub fn to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            let value = number.as_f64().unwrap_or_default();
            if value.fract() == 0.0 && value.abs() < 1e21 {
                format!("{value:.0}")
            } else {
                value.to_string()
            }
        }
        other => other.to_string(),
    }
}

fn interpolate(args: &[Value], context: &EvaluationContext<'_>) -> Result<Value, String> {
    let kind = args
        .first()
        .and_then(Value::as_array)
        .ok_or("`interpolate` needs an interpolation type")?;
    let base = match kind.first().and_then(Value::as_str) {
        Some("linear") => 1.0,
        Some("exponential") => kind
            .get(1)
            .and_then(Value::as_f64)
            .ok_or("exponential interpolation needs a base")?,
        other => return Err(format!("unsupported interpolation {other:?}")),
    };
    let input = evaluate(args.get(1).ok_or("`interpolate` needs an input")?, context)?
        .as_f64()
        .ok_or("`interpolate` input must be a number")?;
    let stops = &args[2..];
    if stops.len() < 2 || !stops.len().is_multiple_of(2) {
        return Err("`interpolate` needs stop/output pairs".into());
    }
    let stops = stops
        .chunks(2)
        .map(|pair| {
            pair[0]
                .as_f64()
                .map(|stop| (stop, &pair[1]))
                .ok_or("`interpolate` stops must be numbers")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (first, last) = (stops[0], stops[stops.len() - 1]);
    if input <= first.0 {
        return evaluate(first.1, context);
    }
    if input >= last.0 {
        return evaluate(last.1, context);
    }
    let index = stops
        .windows(2)
        .position(|pair| input >= pair[0].0 && input < pair[1].0)
        .unwrap_or(0);
    let (lower, upper) = (stops[index], stops[index + 1]);
    let t = interpolation_factor(input, base, lower.0, upper.0);
    let (from, to) = (evaluate(lower.1, context)?, evaluate(upper.1, context)?);
    blend(&from, &to, t)
}

/// MapLibre's `interpolationFactor` (exponential with `base`, linear for 1).
pub fn interpolation_factor(input: f64, base: f64, lower: f64, upper: f64) -> f64 {
    let difference = upper - lower;
    let progress = input - lower;
    if difference == 0.0 {
        0.0
    } else if base == 1.0 {
        progress / difference
    } else {
        (base.powf(progress) - 1.0) / (base.powf(difference) - 1.0)
    }
}

fn blend(from: &Value, to: &Value, t: f64) -> Result<Value, String> {
    match (from, to) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (
                a.as_f64().unwrap_or_default(),
                b.as_f64().unwrap_or_default(),
            );
            Ok(Value::from(a * (1.0 - t) + b * t))
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .map(|(a, b)| blend(a, b, t))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        (Value::String(a), Value::String(b)) => {
            let (a, b) = (
                Rgba::parse(a).ok_or("interpolated colors must parse")?,
                Rgba::parse(b).ok_or("interpolated colors must parse")?,
            );
            let mix = |a: f64, b: f64| a * (1.0 - t) + b * t;
            Ok(Value::from(
                Rgba {
                    r: mix(a.r, b.r),
                    g: mix(a.g, b.g),
                    b: mix(a.b, b.b),
                    a: mix(a.a, b.a),
                }
                .to_css(),
            ))
        }
        _ => Err("`interpolate` outputs must be numbers, arrays or colors".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn eval(expression: Value, properties: Value) -> Value {
        let properties = properties
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        evaluate(
            &expression,
            &EvaluationContext {
                zoom: 7.0,
                properties: &properties,
                id: None,
                geometry_type: "Point",
            },
        )
        .unwrap()
    }

    #[test]
    fn data_driven_ramps_and_filters() {
        let size = json!(["interpolate", ["linear"], ["get", "rank"], 2, 20, 8, 13]);
        let size_at = |rank: i32| eval(size.clone(), json!({ "rank": rank })).as_f64();
        assert_eq!(size_at(2), Some(20.0));
        assert!((size_at(7).unwrap() - (20.0 - 7.0 * 5.0 / 6.0)).abs() < 1e-12);
        assert_eq!(size_at(9), Some(13.0));
        assert_eq!(
            eval(
                json!(["==", ["get", "kind"], "lake"]),
                json!({"kind": "lake"})
            ),
            json!(true)
        );
        assert_eq!(
            eval(json!(["==", "kind", "lake"]), json!({"kind": "river"})),
            json!(false)
        );
        assert_eq!(
            eval(json!(["NotoSans-Regular"]), json!({})),
            json!(["NotoSans-Regular"])
        );
        assert_eq!(
            eval(
                json!(["match", ["get", "k"], ["a", "b"], 1, 2]),
                json!({"k": "b"})
            ),
            json!(1)
        );
        assert_eq!(
            eval(json!(["step", ["zoom"], 1, 5, 2, 8, 3]), json!({})),
            json!(2)
        );
    }
}
