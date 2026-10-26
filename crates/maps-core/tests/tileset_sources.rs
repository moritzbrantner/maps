use maps_core::{
    FlatRasterRuntime, FlatRasterRuntimeLimits, MapCamera, MapsTileset, RasterSourceSpec,
    ViewportSize,
};

fn source(id: &str, revision: &str) -> MapsTileset {
    serde_json::from_value(serde_json::json!({
        "version": 1, "sourceId": id, "dataRevision": revision,
        "format": "mvt", "schema": {"id": "shortbread", "version": "1.0", "sourceLayers": ["water_polygons", "streets"]},
        "transport": {"kind": "xyz", "urlTemplate": "https://example.test/{z}/{x}/{y}.mvt"},
        "projection": "web-mercator", "scheme": "xyz", "bounds": [-180, -85.0511287798066, 180, 85.0511287798066],
        "minZoom": 0, "maxZoom": 2, "tileSize": 512,
        "attribution": "Fixture", "license": "CC0-1.0", "provenance": "Deterministic test fixture"
    })).unwrap()
}

#[test]
fn map_view_sources_reuse_only_the_same_revision_and_preserve_camera() {
    let camera =
        MapCamera::new(179., 0., 3., 0., 0., ViewportSize::new(512., 300.).unwrap()).unwrap();
    let mut runtime = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 2, 512).unwrap(),
        FlatRasterRuntimeLimits::new(8, 16, 4).unwrap(),
    )
    .unwrap();
    let a = source("a", "r1");
    let b = source("b", "r1");
    runtime.activate_tileset(a.clone()).unwrap();
    let cold = runtime.frame_plan().unwrap();
    assert!(!cold.requests.is_empty());
    for tile in &cold.requests {
        runtime.mark_loaded(*tile);
    }
    runtime.frame_plan().unwrap();
    runtime.activate_tileset(b).unwrap();
    let other = runtime.frame_plan().unwrap();
    assert!(!other.requests.is_empty());
    runtime.activate_tileset(a.clone()).unwrap();
    let warm = runtime.frame_plan().unwrap();
    assert!(
        warm.requests
            .iter()
            .all(|tile| !cold.requests.contains(tile))
    );
    assert_eq!(runtime.camera(), camera);
    let mut changed = a;
    changed.data_revision = "r2".into();
    runtime.activate_tileset(changed).unwrap();
    assert!(!runtime.frame_plan().unwrap().requests.is_empty());
}

#[test]
fn malformed_or_incompatible_tilesets_do_not_replace_the_active_source() {
    let mut manifest = source("a", "r1");
    assert!(manifest.validate().is_ok());
    manifest.schema.version = "2".into();
    assert!(manifest.validate().is_err());
    manifest.schema.version = "1.0".into();
    manifest.bounds[1] = f64::NAN;
    assert!(manifest.validate().is_err());
}

#[test]
fn source_identity_excludes_transport_and_observation_but_not_revision_or_schema() {
    let a = source("a", "r1");
    let mut token_rotation = a.clone();
    token_rotation.transport = maps_core::TilesetTransport::Xyz {
        url_template: "https://mirror.test/{z}/{x}/{y}?token=rotated".into(),
    };
    token_rotation.observation = Some(maps_core::TilesetObservation {
        snapshot: "1816".into(),
        effective_date: Some("1816-01-01".into()),
    });
    assert_eq!(a.identity(), token_rotation.identity());
    token_rotation.data_revision = "r2".into();
    assert_ne!(a.identity(), token_rotation.identity());
}

#[test]
fn inactive_sources_share_the_existing_hard_cache_budget_and_eviction_order() {
    let camera =
        MapCamera::new(0., 0., 0., 0., 0., ViewportSize::new(200., 200.).unwrap()).unwrap();
    let mut runtime = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 0, 512).unwrap(),
        FlatRasterRuntimeLimits::new(1, 2, 1).unwrap(),
    )
    .unwrap();
    let mut a = source("a", "r1");
    a.max_zoom = 0;
    let mut b = source("b", "r1");
    b.max_zoom = 0;
    let mut c = source("c", "r1");
    c.max_zoom = 0;
    for descriptor in [a.clone(), b, c] {
        runtime.activate_tileset(descriptor).unwrap();
        let frame = runtime.frame_plan().unwrap();
        for tile in frame.requests {
            runtime.mark_loaded(tile);
        }
        runtime.frame_plan().unwrap();
    }
    let evictions = runtime.take_source_evictions();
    assert_eq!(evictions.len(), 1);
    assert_eq!(evictions[0].0, a.identity());
    runtime.activate_tileset(a).unwrap();
    assert_eq!(runtime.frame_plan().unwrap().requests.len(), 1);
}

#[test]
fn coverage_filters_requests_without_clamping_camera_or_confusing_world_placement() {
    let camera = MapCamera::new(
        179.,
        0.,
        0.,
        0.,
        0.,
        ViewportSize::new(1200., 300.).unwrap(),
    )
    .unwrap();
    let mut runtime = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 2, 512).unwrap(),
        FlatRasterRuntimeLimits::default(),
    )
    .unwrap();
    let mut manifest = source("a", "r1");
    manifest.max_zoom = 0;
    manifest.bounds = [170., -10., -170., 10.];
    runtime.activate_tileset(manifest).unwrap();
    let frame = runtime.frame_plan().unwrap();
    assert_eq!(frame.requests.len(), 1);
    assert!(
        frame
            .placements
            .iter()
            .map(|p| p.world_copy)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            > 1
    );
    runtime.set_view_state(179., 0., 4.).unwrap();
    let before_switch = runtime.camera();
    let mut absent = source("a", "r2");
    absent.min_zoom = 4;
    absent.max_zoom = 4;
    absent.bounds = [-30., 30., -20., 40.];
    runtime.activate_tileset(absent).unwrap();
    assert!(runtime.frame_plan().unwrap().requests.is_empty());
    assert_eq!(runtime.camera(), before_switch);
}
