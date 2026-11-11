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
fn formats_cluster_labels_from_exact_point_counts() {
    let points = normalize_map_points(
        (0..12_004)
            .map(|index| {
                let (latitude, longitude) = if index < 7_969 {
                    (52.52, 13.405)
                } else {
                    (48.8566, 2.3522)
                };
                MapPoint::new(latitude, longitude).with_id(index.to_string())
            })
            .collect::<Vec<_>>(),
    );
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");

    let whole_cluster = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [-180.0, -85.0, 180.0, 85.0],
            zoom: 0.0,
        })
        .expect("viewport should aggregate")
        .features
        .into_iter()
        .find_map(|feature| match feature {
            AggregatedMapFeature::Cluster(cluster) => Some(cluster),
            AggregatedMapFeature::Point(_) => None,
        })
        .expect("low zoom should return one cluster");
    assert_eq!(whole_cluster.point_count, 12_004);
    assert_eq!(whole_cluster.point_count_abbreviated, "12.004k");

    let separate_clusters = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [-180.0, -85.0, 180.0, 85.0],
            zoom: 4.0,
        })
        .expect("viewport should aggregate");
    let berlin_cluster = separate_clusters
        .features
        .iter()
        .find_map(|feature| match feature {
            AggregatedMapFeature::Cluster(cluster) if cluster.point_count == 7_969 => Some(cluster),
            _ => None,
        })
        .expect("high zoom should separate the Berlin cluster");
    assert_eq!(berlin_cluster.point_count_abbreviated, "7.969k");
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
        MapPoint::new(latitude, longitude).with_id("precise-point"),
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

#[test]
fn indexes_unwrapped_longitudes_at_their_wrapped_location() {
    // A moving feature may cross the antimeridian with unwrapped longitudes: 183°E is 177°W.
    let points = normalize_map_points(vec![
        MapPoint::new(10.0, 183.0).with_id("east"),
        MapPoint::new(-10.0, -190.0).with_id("west"),
        MapPoint::new(0.0, 365.0).with_id("lap"),
    ]);
    let mut index = PointAggregationIndex::new(points, PointAggregationOptions::default())
        .expect("aggregation index should build");
    let mut visible = |bounds: [f64; 4]| {
        let mut points = index
            .get_viewport_aggregation(ViewportAggregationQuery { bounds, zoom: 6.0 })
            .expect("viewport should aggregate")
            .features
            .into_iter()
            .map(|feature| match feature {
                AggregatedMapFeature::Point(point) => (point.point.id, point.coordinates),
                AggregatedMapFeature::Cluster(_) => panic!("distant points must not cluster"),
            })
            .collect::<Vec<_>>();
        points.sort_by(|left, right| left.0.cmp(&right.0));
        points
    };

    // Found where it is on the globe, reported with the coordinates it was supplied with.
    assert_eq!(
        visible([-178.0, 5.0, -176.0, 15.0]),
        vec![("east".to_owned(), [183.0, 10.0])]
    );
    assert_eq!(
        visible([4.0, -1.0, 6.0, 1.0]),
        vec![("lap".to_owned(), [365.0, 0.0])]
    );
    // A viewport across the antimeridian sees both, once each.
    assert_eq!(
        visible([165.0, -20.0, 190.0, 20.0]),
        vec![
            ("east".to_owned(), [183.0, 10.0]),
            ("west".to_owned(), [-190.0, -10.0])
        ]
    );
}

#[test]
fn an_empty_point_set_builds_an_empty_index() {
    // A Map-Scoped Timeline sample before any track is admitted has no points (#172).
    let mut index = PointAggregationIndex::new(Vec::new(), PointAggregationOptions::default())
        .expect("an empty aggregation index should build");
    let aggregation = index
        .get_viewport_aggregation(ViewportAggregationQuery {
            bounds: [-180.0, -85.0, 180.0, 85.0],
            zoom: 4.0,
        })
        .expect("an empty viewport should aggregate");

    assert!(aggregation.features.is_empty());
    assert_eq!(aggregation.summary.visible_point_count, 0);
}

#[test]
fn an_empty_index_has_no_clusters() {
    let index = PointAggregationIndex::new(Vec::new(), PointAggregationOptions::default())
        .expect("an empty aggregation index should build");

    assert!(index.get_cluster_expansion_zoom(0).is_err());
    assert!(index.get_cluster_leaves(0, 10, 0).is_err());
    assert!(index.get_point_by_id("a").is_none());
}
