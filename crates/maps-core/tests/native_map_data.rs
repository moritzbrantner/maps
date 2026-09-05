use maps_core::{MapPoint, get_bounds_from_points, normalize_map_points};

#[test]
fn normalizes_native_map_data_deterministically() {
    let points = vec![
        MapPoint::new(f64::NAN, 8.0).with_metric("ignored", f64::INFINITY),
        MapPoint::new(49.0, 8.0)
            .with_label("Karlsruhe")
            .with_metric("demand", 42.0)
            .with_metric("invalid", f64::NAN),
        MapPoint::new(50.0, 9.0).with_id("explicit"),
    ];

    let normalized = normalize_map_points(points);

    assert_eq!(normalized.len(), 2);
    assert_eq!(normalized[0].id, "1");
    assert_eq!(normalized[0].label, "Karlsruhe");
    assert_eq!(normalized[0].metrics.get("demand"), Some(&42.0));
    assert!(!normalized[0].metrics.contains_key("invalid"));
    assert_eq!(normalized[1].id, "explicit");
    assert_eq!(normalized[1].label, "");
}

#[test]
fn computes_bounds_from_finite_points_only() {
    let points = vec![
        MapPoint::new(48.0, 7.0),
        MapPoint::new(f64::INFINITY, 8.0),
        MapPoint::new(50.0, 9.0),
        MapPoint::new(49.0, f64::NAN),
    ];

    let bounds = get_bounds_from_points(&points).expect("finite points should produce bounds");

    assert_eq!(bounds.as_array(), [7.0, 48.0, 9.0, 50.0]);
}

#[test]
fn returns_no_bounds_when_every_point_is_non_finite() {
    let points = vec![
        MapPoint::new(f64::NAN, 8.0),
        MapPoint::new(49.0, f64::NEG_INFINITY),
    ];

    assert_eq!(get_bounds_from_points(&points), None);
}
