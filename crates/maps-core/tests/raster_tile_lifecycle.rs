use maps_core::{
    FlatRasterRuntime, FlatRasterRuntimeLimits, MapCamera, RasterSourceSpec, ViewportSize,
};

#[test]
fn failed_tiles_do_not_starve_the_remaining_visible_cover() {
    let camera = MapCamera::new(
        13.405,
        52.52,
        6.0,
        0.0,
        0.0,
        ViewportSize::new(800.0, 600.0).unwrap(),
    )
    .unwrap();
    let mut runtime = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 19, 256).unwrap(),
        FlatRasterRuntimeLimits::new(64, 64, 1).unwrap(),
    )
    .unwrap();
    let initial = runtime.frame_plan().unwrap();
    let failed_tile = initial.requests[0];
    runtime.mark_failed(failed_tile);

    let next = runtime.frame_plan().unwrap();
    assert_eq!(next.requests.len(), 1);
    assert_ne!(next.requests[0], failed_tile);
    runtime.mark_loaded(next.requests[0]);

    // Every other tile must make progress, then the queue must settle even when
    // the browser asks for more frames while the failed tile stays visible.
    for _ in 0..initial.placements.len() {
        let plan = runtime.frame_plan().unwrap();
        for tile in plan.requests {
            assert_ne!(tile, failed_tile);
            runtime.mark_loaded(tile);
        }
    }
    assert!(runtime.frame_plan().unwrap().requests.is_empty());

    // Leaving and revisiting the area allows recovery without retaining a
    // permanent failure cache or treating an unsuccessful fetch as ready.
    runtime.set_view_state(-120.0, 20.0, 6.0).unwrap();
    runtime.frame_plan().unwrap();
    runtime.set_view_state(13.405, 52.52, 6.0).unwrap();
    assert_eq!(runtime.frame_plan().unwrap().requests, [failed_tile]);
}

#[test]
fn cancelled_tile_completions_do_not_populate_the_cache() {
    let camera = MapCamera::new(
        13.405,
        52.52,
        6.0,
        0.0,
        0.0,
        ViewportSize::new(256.0, 256.0).unwrap(),
    )
    .unwrap();
    let mut runtime = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 19, 256).unwrap(),
        FlatRasterRuntimeLimits::default(),
    )
    .unwrap();
    let initial = runtime.frame_plan().unwrap();
    runtime.set_view_state(-120.0, 20.0, 6.0).unwrap();
    let away = runtime.frame_plan().unwrap();
    assert_eq!(away.cancellations.len(), initial.requests.len());
    for tile in initial.requests.iter().copied() {
        runtime.mark_loaded(tile);
    }

    runtime.set_view_state(13.405, 52.52, 6.0).unwrap();
    assert_eq!(runtime.frame_plan().unwrap().requests, initial.requests);
}
