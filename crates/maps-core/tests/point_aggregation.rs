use maps_core::{
    AggregatedMapFeature, MapPoint, PointAggregationIndex, PointAggregationOptions,
    ViewportAggregationQuery, normalize_map_points,
};

#[test]
fn clusters_points_and_sums_maps_owned_metrics() {
    let points = normalize_map_points(vec![
        MapPoint::new(52.5200, 13.4050)
            .with_id("a")
            .with_metric("orders", 3.0),
        MapPoint::new(52.5202, 13.4052)
            .with_id("b")
            .with_metric("orders", 2.0),
        MapPoint::new(48.8566, 2.3522)
            .with_id("paris")
            .with_metric("orders", 7.0),
    ]);
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [-180.0, -85.0, 180.0, 85.0],
            zoom: 4.0,
        })
        .expect("viewport should aggregate");

    assert_eq!(aggregation.summary.visible_point_count, 3);
    assert_eq!(aggregation.summary.metrics.get("orders"), Some(&12.0));
    assert!(
        aggregation
            .features
            .iter()
            .any(|feature| matches!(feature, AggregatedMapFeature::Cluster(_)))
    );
}

#[test]
fn matches_javascript_supercluster_float32_cluster_centroid() {
    let points = normalize_map_points(vec![
        MapPoint::new(52.5200, 13.4050).with_id("berlin-a"),
        MapPoint::new(52.5204, 13.4054).with_id("berlin-b"),
        MapPoint::new(52.5210, 13.4060).with_id("berlin-c"),
        MapPoint::new(48.8566, 2.3522).with_id("paris"),
    ]);
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [-180.0, -85.0, 180.0, 85.0],
            zoom: 2.0,
        })
        .expect("viewport should aggregate");
    let cluster = aggregation
        .features
        .iter()
        .find_map(|feature| match feature {
            AggregatedMapFeature::Cluster(cluster) => Some(cluster),
            AggregatedMapFeature::Point(_) => None,
        })
        .expect("fixture should produce one cluster");

    assert!((cluster.coordinates[0] - 10.642147064208984).abs() <= 1e-9);
    assert!((cluster.coordinates[1] - 51.6312860782416).abs() <= 1e-9);
}

#[test]
fn preserves_exact_source_coordinates_for_unclustered_points() {
    let longitude = 13.405_123_456_789;
    let latitude = 52.520_987_654_321;
    let points = normalize_map_points(vec![
        MapPoint::new(latitude, longitude).with_id("precise-point")
    ]);
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [13.0, 52.0, 14.0, 53.0],
            zoom: 17.0,
        })
        .expect("viewport should aggregate");
    let point = aggregation
        .features
        .iter()
        .find_map(|feature| match feature {
            AggregatedMapFeature::Point(point) => Some(point),
            AggregatedMapFeature::Cluster(_) => None,
        })
        .expect("fixture should return the source point");

    assert_eq!(point.coordinates, [longitude, latitude]);
    assert_eq!(point.point.longitude, longitude);
    assert_eq!(point.point.latitude, latitude);
}

#[test]
fn returns_cluster_leaves_by_original_stable_ids() {
    let points = normalize_map_points(
        (0..20)
            .map(|index| {
                MapPoint::new(
                    52.52 + f64::from(index) * 0.0002,
                    13.405 + f64::from(index) * 0.0002,
                )
                .with_id(format!("point-{index}"))
                .with_metric("orders", 1.0)
            })
            .collect::<Vec<_>>(),
    );
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [13.3, 52.4, 13.6, 52.7],
            zoom: 4.0,
        })
        .expect("viewport should aggregate");
    let cluster_id = aggregation
        .features
        .iter()
        .find_map(|feature| match feature {
            AggregatedMapFeature::Cluster(cluster) => Some(cluster.cluster_id),
            AggregatedMapFeature::Point(_) => None,
        })
        .expect("fixture should contain a cluster");
    let leaves = index
        .get_cluster_leaves(cluster_id, 5, 0)
        .expect("cluster leaves should resolve");

    assert_eq!(leaves.len(), 5);
    assert!(leaves.iter().all(|point| point.id.starts_with("point-")));
}

#[test]
fn deduplicates_antimeridian_crossing_viewport_points() {
    let points = normalize_map_points(vec![
        MapPoint::new(0.0, 179.8).with_id("east"),
        MapPoint::new(0.0, -179.8).with_id("west"),
    ]);
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [170.0, -10.0, -170.0, 10.0],
            zoom: 12.0,
        })
        .expect("viewport should aggregate");
    let mut ids = aggregation
        .features
        .iter()
        .filter_map(|feature| match feature {
            AggregatedMapFeature::Point(point) => Some(point.point.id.as_str()),
            AggregatedMapFeature::Cluster(_) => None,
        })
        .collect::<Vec<_>>();
    ids.sort_unstable();

    assert_eq!(aggregation.summary.visible_point_count, 2);
    assert_eq!(ids, vec!["east", "west"]);
}

#[test]
fn preserves_metric_totals_for_large_inputs() {
    let points = normalize_map_points(
        (0..20_000)
            .map(|index| {
                MapPoint::new(
                    -70.0 + f64::from(index % 140) * 0.9,
                    -160.0 + f64::from(index % 320),
                )
                .with_id(index.to_string())
                .with_metric("weight", 50.5)
            })
            .collect::<Vec<_>>(),
    );
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [-180.0, -85.0, 180.0, 85.0],
            zoom: 1.0,
        })
        .expect("viewport should aggregate");

    assert_eq!(aggregation.summary.visible_point_count, 20_000);
    assert_eq!(
        aggregation.summary.metrics.get("weight"),
        Some(&1_010_000.0)
    );
}

#[test]
fn rejects_invalid_options_and_non_finite_queries() {
    let points = normalize_map_points(vec![MapPoint::new(49.0, 8.0)]);
    let invalid_options = PointAggregationOptions {
        radius: f64::NAN,
        ..PointAggregationOptions::default()
    };
    assert!(PointAggregationIndex::new(points.clone(), invalid_options).is_err());

    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    assert!(
        index
            .get_viewport_aggregation(ViewportAggregationQuery {
                bounds: [-180.0, -85.0, 180.0, 85.0],
                zoom: f64::NAN,
            })
            .is_err()
    );
}
