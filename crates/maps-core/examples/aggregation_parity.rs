use std::{collections::BTreeMap, env, fs};

use maps_core::{
    AggregatedMapFeature, MapPoint, PointAggregationIndex, PointAggregationOptions,
    ViewportAggregation, ViewportAggregationQuery, normalize_map_points,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureFile {
    cases: Vec<FixtureCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    name: String,
    points: Vec<FixturePoint>,
    options: FixtureOptions,
    query: FixtureQuery,
    leaf_limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixturePoint {
    id: Option<String>,
    label: Option<String>,
    latitude: f64,
    longitude: f64,
    #[serde(default)]
    metrics: BTreeMap<String, f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureOptions {
    extent: f64,
    max_zoom: u8,
    min_zoom: u8,
    radius: f64,
}

#[derive(Debug, Deserialize)]
struct FixtureQuery {
    bounds: [f64; 4],
    zoom: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = env::args()
        .nth(1)
        .ok_or("expected aggregation parity fixture path")?;
    let fixtures: FixtureFile = serde_json::from_str(&fs::read_to_string(fixture_path)?)?;
    let mut cases = Vec::with_capacity(fixtures.cases.len());

    for fixture in fixtures.cases {
        cases.push(run_case(fixture)?);
    }

    println!("{}", serde_json::to_string(&json!({ "cases": cases }))?);
    Ok(())
}

fn run_case(fixture: FixtureCase) -> Result<Value, Box<dyn std::error::Error>> {
    let points = normalize_map_points(fixture.points.into_iter().map(|point| MapPoint {
        id: point.id,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        metrics: point.metrics,
    }));
    let options = PointAggregationOptions {
        extent: fixture.options.extent,
        max_zoom: fixture.options.max_zoom,
        min_zoom: fixture.options.min_zoom,
        radius: fixture.options.radius,
    };
    let mut index = PointAggregationIndex::new(points, options)?;
    let aggregation = index.get_viewport_aggregation(ViewportAggregationQuery {
        bounds: fixture.query.bounds,
        zoom: fixture.query.zoom,
    })?;
    let cluster_ids = aggregation
        .features
        .iter()
        .filter_map(|feature| match feature {
            AggregatedMapFeature::Cluster(cluster) => Some(cluster.cluster_id),
            AggregatedMapFeature::Point(_) => None,
        })
        .collect::<Vec<_>>();
    let mut leaves_by_cluster = BTreeMap::new();

    for cluster_id in cluster_ids {
        let leaves = index
            .get_cluster_leaves(cluster_id, fixture.leaf_limit, 0)?
            .into_iter()
            .map(|point| point.id)
            .collect::<Vec<_>>();
        leaves_by_cluster.insert(cluster_id.to_string(), leaves);
    }

    Ok(json!({
        "name": fixture.name,
        "aggregation": aggregation_to_json(&aggregation),
        "leavesByCluster": leaves_by_cluster,
    }))
}

fn aggregation_to_json(aggregation: &ViewportAggregation) -> Value {
    let features = aggregation
        .features
        .iter()
        .map(|feature| match feature {
            AggregatedMapFeature::Cluster(cluster) => json!({
                "kind": "cluster",
                "clusterId": cluster.cluster_id,
                "coordinates": cluster.coordinates,
                "expansionZoom": cluster.expansion_zoom,
                "metrics": cluster.metrics,
                "pointCount": cluster.point_count,
                "pointCountAbbreviated": cluster.point_count_abbreviated,
            }),
            AggregatedMapFeature::Point(point) => json!({
                "kind": "point",
                "coordinates": point.coordinates,
                "metrics": point.metrics,
                "pointId": point.point.id,
            }),
        })
        .collect::<Vec<_>>();

    json!({
        "features": features,
        "summary": {
            "bounds": aggregation.summary.bounds,
            "metrics": aggregation.summary.metrics,
            "visibleClusterCount": aggregation.summary.visible_cluster_count,
            "visiblePointCount": aggregation.summary.visible_point_count,
            "visibleUnclusteredCount": aggregation.summary.visible_unclustered_count,
            "zoom": aggregation.summary.zoom,
        }
    })
}
