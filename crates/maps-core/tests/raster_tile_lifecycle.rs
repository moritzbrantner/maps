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

    // Every other requested tile, including bounded prefetch work, must make
    // progress and settle while the failed visible tile stays suppressed.
    let mut settled = false;
    for _ in 0..64 {
        let plan = runtime.frame_plan().unwrap();
        if plan.requests.is_empty() {
            settled = true;
            break;
        }
        for tile in plan.requests {
            assert_ne!(tile, failed_tile);
            runtime.mark_loaded(tile);
        }
    }
    assert!(settled, "raster request cover did not settle");

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

#[test]
fn directional_prefetch_prepares_the_next_view_without_growing_the_request_budget() {
    // raster-tile-churn-v1: move east while the current viewport stays in its
    // original tiles, then travel two tiles farther and reuse the leading edge.
    let camera = MapCamera::new(
        0.0,
        0.0,
        5.0,
        0.0,
        0.0,
        ViewportSize::new(256.0, 256.0).unwrap(),
    )
    .unwrap();
    let mut runtime = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 19, 512).unwrap(),
        FlatRasterRuntimeLimits::new(64, 64, 64).unwrap(),
    )
    .unwrap();
    let initial = runtime.frame_plan().unwrap();
    for tile in &initial.requests {
        runtime.mark_loaded(*tile);
    }
    runtime.pan_by_pixels(-16.0, 0.0).unwrap();
    let ahead = runtime.frame_plan().unwrap();
    let target = maps_core::TileId::new(5, 18, 16).unwrap();
    assert!(
        ahead.requests.contains(&target),
        "prepare two tiles ahead of eastward travel"
    );
    assert!(!ahead.placements.iter().any(|p| p.tile == target));
    for tile in &ahead.requests {
        runtime.mark_loaded(*tile);
    }
    assert!(
        runtime.frame_plan().unwrap().requests.is_empty(),
        "idle prediction must settle"
    );
    runtime.pan_by_pixels(-1024.0, 0.0).unwrap();
    let entered = runtime.frame_plan().unwrap();
    assert!(entered.placements.iter().any(|p| p.tile == target));
    assert!(
        !entered.requests.contains(&target),
        "predicted tile must be reused"
    );

    // From a cold cache the directional cover cannot exceed the original ring.
    let mut cold = FlatRasterRuntime::new(
        camera,
        runtime.source(),
        FlatRasterRuntimeLimits::new(64, 64, 64).unwrap(),
    )
    .unwrap();
    cold.frame_plan().unwrap();
    cold.pan_by_pixels(-16.0, 0.0).unwrap();
    let shifted = cold.frame_plan().unwrap();
    assert!(
        initial.requests.len() - shifted.cancellations.len() + shifted.requests.len()
            <= initial.requests.len()
    );
}

fn prefetch_runtime(longitude: f64, latitude: f64, capacity: usize) -> FlatRasterRuntime {
    FlatRasterRuntime::new(
        MapCamera::new(
            longitude,
            latitude,
            5.0,
            0.0,
            0.0,
            ViewportSize::new(256.0, 256.0).unwrap(),
        )
        .unwrap(),
        RasterSourceSpec::new(0, 19, 512).unwrap(),
        FlatRasterRuntimeLimits::new(capacity, capacity, capacity).unwrap(),
    )
    .unwrap()
}

#[test]
fn reversing_travel_cancels_obsolete_prediction_and_ignores_late_completions() {
    let mut runtime = prefetch_runtime(0.0, 0.0, 64);
    for tile in runtime.frame_plan().unwrap().requests {
        runtime.mark_loaded(tile);
    }
    runtime.pan_by_pixels(-16.0, 0.0).unwrap();
    let east = runtime.frame_plan().unwrap();
    let east_tile = maps_core::TileId::new(5, 18, 16).unwrap();
    assert!(east.requests.contains(&east_tile));
    runtime.pan_by_pixels(16.0, 0.0).unwrap();
    let west = runtime.frame_plan().unwrap();
    assert!(west.cancellations.contains(&east_tile));
    assert!(
        west.requests
            .contains(&maps_core::TileId::new(5, 13, 16).unwrap())
    );
    // A network callback arriving after cancellation must not make it resident.
    runtime.mark_loaded(east_tile);
    runtime.pan_by_pixels(-16.0, 0.0).unwrap();
    assert!(runtime.frame_plan().unwrap().requests.contains(&east_tile));
}

#[test]
fn directional_prediction_wraps_longitude_and_respects_poles_and_small_caches() {
    let mut wrapped = prefetch_runtime(179.8, 0.0, 64);
    for tile in wrapped.frame_plan().unwrap().requests {
        wrapped.mark_loaded(tile);
    }
    wrapped.pan_by_pixels(-16.0, 0.0).unwrap();
    assert!(
        wrapped
            .frame_plan()
            .unwrap()
            .requests
            .contains(&maps_core::TileId::new(5, 2, 16).unwrap())
    );

    for (latitude, capacity) in [(85.0, 8), (-85.0, 8), (0.0, 4)] {
        let mut runtime = prefetch_runtime(0.0, latitude, capacity);
        for tile in runtime.frame_plan().unwrap().requests {
            runtime.mark_loaded(tile);
        }
        runtime
            .pan_by_pixels(-16.0, if latitude > 0.0 { 16.0 } else { -16.0 })
            .unwrap();
        let plan = runtime.frame_plan().unwrap();
        assert!(plan.requests.len() <= capacity);
        assert!(plan.requests.iter().all(|tile| tile.x < 32 && tile.y < 32));
        // Complete all work: cache pressure must not cause an idle fetch/evict loop.
        for tile in plan.requests {
            runtime.mark_loaded(tile);
        }
        for _ in 0..4 {
            let plan = runtime.frame_plan().unwrap();
            for tile in plan.requests {
                runtime.mark_loaded(tile);
            }
        }
        assert!(runtime.frame_plan().unwrap().requests.is_empty());
    }
}

#[test]
fn non_pan_camera_changes_clear_directional_prediction() {
    for change in 0..4 {
        let mut runtime = prefetch_runtime(0.0, 0.0, 64);
        for tile in runtime.frame_plan().unwrap().requests {
            runtime.mark_loaded(tile);
        }
        runtime.pan_by_pixels(-16.0, 0.0).unwrap();
        let predicted = runtime.frame_plan().unwrap().requests;
        assert!(!predicted.is_empty());
        let camera = runtime.camera();
        match change {
            0 => runtime.resize(270.0, 270.0).unwrap(),
            1 => runtime
                .set_camera_state(camera.longitude, camera.latitude, 5.0, 20.0, 0.0)
                .unwrap(),
            2 => runtime
                .set_view_state(camera.longitude, camera.latitude, 6.0)
                .unwrap(),
            _ => runtime.set_view_state(90.0, 0.0, 5.0).unwrap(),
        }
        let mut stationary = FlatRasterRuntime::new(
            runtime.camera(),
            runtime.source(),
            FlatRasterRuntimeLimits::new(64, 64, 64).unwrap(),
        )
        .unwrap();
        let stationary_cover = stationary.frame_plan().unwrap().requests;
        let reset = runtime.frame_plan().unwrap();
        assert!(
            reset
                .requests
                .iter()
                .all(|tile| stationary_cover.contains(tile))
        );
        assert!(
            predicted
                .iter()
                .filter(|tile| !stationary_cover.contains(tile))
                .all(|tile| reset.cancellations.contains(tile))
        );
    }
}
