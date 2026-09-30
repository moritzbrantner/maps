use maps_core::{
    BoundedFlatRasterRuntime, FlatRasterRuntime, FlatRasterRuntimeLimits, MapCamera,
    RasterSourceSpec, ViewportSize,
};

#[test]
fn batches_preserve_scalar_projection_across_camera_changes_and_invalid_points() {
    let camera = MapCamera::new(
        179.8,
        10.0,
        4.0,
        0.0,
        0.0,
        ViewportSize::new(1280.0, 720.0).unwrap(),
    )
    .unwrap();
    let inner = FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 19, 256).unwrap(),
        FlatRasterRuntimeLimits::default(),
    )
    .unwrap();
    let mut runtime = BoundedFlatRasterRuntime::new(inner, None).unwrap();
    let coordinates = [
        [179.9, 10.0],
        [-179.9, 10.0],
        [540.1, 20.0],
        [13.405, 52.52],
        [f64::NAN, 0.0],
        [0.0, f64::INFINITY],
        [0.0, 91.0],
        [0.0, -90.0],
    ];
    for (longitude, latitude, zoom, bearing, pitch) in [
        (179.8, 10.0, 4.0, 0.0, 0.0),
        (13.405, 52.52, 8.0, 35.0, 40.0),
        (-179.8, 10.0, 4.0, -75.0, 20.0),
    ] {
        runtime
            .set_camera_state(longitude, latitude, zoom, bearing, pitch)
            .unwrap();
        runtime.resize(800.0, 600.0).unwrap();
        let batch = runtime
            .project_screen_batch(&coordinates)
            .collect::<Vec<_>>();
        assert_eq!(batch.len(), coordinates.len());
        for (actual, [longitude, latitude]) in batch.into_iter().zip(coordinates) {
            assert_eq!(actual, runtime.project_screen(longitude, latitude).ok());
        }
        assert_eq!(runtime.project_screen_batch(&[]).count(), 0);
    }
}
