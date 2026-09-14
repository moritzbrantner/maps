use maps_core::{MapCamera, ScreenCoordinate, ViewportSize};

const SCREEN_EPSILON: f64 = 1.0e-3;
const GEO_EPSILON: f64 = 2.0e-5;

fn camera(bearing: f64, pitch: f64) -> MapCamera {
    MapCamera::new(
        13.405,
        52.52,
        8.0,
        bearing,
        pitch,
        ViewportSize::new(1280.0, 720.0).expect("valid viewport"),
    )
    .expect("valid camera")
}

fn wrapped_longitude_error(left: f64, right: f64) -> f64 {
    let delta = (left - right).rem_euclid(360.0);
    delta.min(360.0 - delta)
}

#[test]
fn zero_bearing_and_pitch_preserve_flat_projection() {
    let camera = camera(0.0, 0.0);
    let points = [
        (13.405, 52.52),
        (13.75, 52.65),
        (12.95, 52.31),
        (14.05, 52.42),
    ];

    for (longitude, latitude) in points {
        let flat = camera
            .project_screen(longitude, latitude)
            .expect("flat projection is supported");
        let matrix = camera
            .project_screen_matrix(longitude, latitude)
            .expect("matrix projection is supported");

        assert!(
            (flat.x - matrix.x).abs() <= SCREEN_EPSILON,
            "x: {flat:?} != {matrix:?}"
        );
        assert!(
            (flat.y - matrix.y).abs() <= SCREEN_EPSILON,
            "y: {flat:?} != {matrix:?}"
        );
    }
}

#[test]
fn bearing_rotates_map_without_changing_geographic_authority() {
    let camera = MapCamera::new(
        0.0,
        0.0,
        5.0,
        90.0,
        0.0,
        ViewportSize::new(800.0, 600.0).expect("valid viewport"),
    )
    .expect("valid camera");

    let east = camera
        .project_screen_matrix(1.0, 0.0)
        .expect("east point projects");

    assert!((east.x - 400.0).abs() <= SCREEN_EPSILON);
    assert!(
        east.y < 300.0,
        "positive bearing should rotate east toward screen-up"
    );
}

#[test]
fn project_unproject_round_trips_across_bearing_and_pitch() {
    let target = (13.62, 52.61);
    let camera_states = [(0.0, 0.0), (30.0, 20.0), (-75.0, 42.0), (145.0, 60.0)];

    for (bearing, pitch) in camera_states {
        let camera = camera(bearing, pitch);
        let screen = camera
            .project_screen_matrix(target.0, target.1)
            .expect("target projects");
        let restored = camera
            .unproject_screen_matrix(screen)
            .expect("projected point unprojects back to map plane");

        assert!(
            wrapped_longitude_error(restored.longitude, target.0) <= GEO_EPSILON,
            "bearing={bearing} pitch={pitch}: longitude {} != {}",
            restored.longitude,
            target.0,
        );
        assert!(
            (restored.latitude - target.1).abs() <= GEO_EPSILON,
            "bearing={bearing} pitch={pitch}: latitude {} != {}",
            restored.latitude,
            target.1,
        );
    }
}

#[test]
fn local_render_frame_exposes_finite_shared_matrix() {
    let elements = camera(37.0, 50.0)
        .local_render_frame()
        .expect("local frame is representable")
        .view_projection_elements();

    assert!(elements.into_iter().all(f32::is_finite));
}

#[test]
fn non_finite_screen_unprojection_fails_closed() {
    let camera = camera(25.0, 35.0);

    assert!(
        camera
            .unproject_screen_matrix(ScreenCoordinate {
                x: f64::NAN,
                y: 10.0,
            })
            .is_none()
    );
}
