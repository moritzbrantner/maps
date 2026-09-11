use maps_core::{
    MapCamera, ScreenCoordinate, TileId, ViewportSize, project_web_mercator,
    unproject_web_mercator, world_size, wrap_longitude,
};

const EPSILON: f64 = 1e-9;

fn assert_near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= EPSILON,
        "expected {actual} to be within {EPSILON} of {expected}"
    );
}

#[test]
fn web_mercator_round_trips_representative_coordinates() {
    let coordinates = [
        [0.0, 0.0],
        [13.405, 52.52],
        [-122.4194, 37.7749],
        [179.9, 10.0],
        [-179.9, -10.0],
    ];

    for [longitude, latitude] in coordinates {
        let world = project_web_mercator(longitude, latitude).expect("finite coordinate");
        let geographic = unproject_web_mercator(world).expect("finite world coordinate");
        assert_near(geographic.longitude, longitude);
        assert_near(geographic.latitude, latitude);
    }
}

#[test]
fn projection_clamps_the_finite_mercator_latitude_domain_exactly() {
    let north = project_web_mercator(0.0, 90.0).expect("finite coordinate");
    let south = project_web_mercator(0.0, -90.0).expect("finite coordinate");

    assert_eq!(north.y, 0.0);
    assert_eq!(south.y, 1.0);
}

#[test]
fn longitude_wrap_is_canonical_across_world_copies() {
    assert_near(wrap_longitude(180.0), -180.0);
    assert_near(wrap_longitude(540.0), -180.0);
    assert_near(wrap_longitude(-540.0), -180.0);
    assert_near(wrap_longitude(181.0), -179.0);
}

#[test]
fn longitude_wrap_preserves_representable_values_adjacent_to_antimeridian() {
    let west_adjacent = -180.000_000_000_000_03;
    let east_adjacent = 179.999_999_999_999_97;

    assert_eq!(wrap_longitude(west_adjacent), east_adjacent);
    assert_eq!(wrap_longitude(east_adjacent), east_adjacent);

    let projected = project_web_mercator(west_adjacent, 0.0).expect("finite coordinate");
    assert!(projected.x >= 0.0);
    assert!(projected.x < 1.0);
}

#[test]
fn world_size_rejects_overflow_underflow_and_invalid_tile_sizes() {
    assert_eq!(world_size(1023.0, 512.0), None);
    assert_eq!(world_size(-1075.0, 512.0), None);
    assert_eq!(world_size(2.0, 0.0), None);
    assert_eq!(world_size(2.0, f64::NAN), None);
    assert_eq!(world_size(2.0, 512.0), Some(2048.0));
}

#[test]
fn camera_rejects_zoom_with_non_finite_derived_world_scale() {
    let viewport = ViewportSize::new(1280.0, 720.0).expect("valid viewport");

    assert_eq!(MapCamera::new(0.0, 0.0, 1023.0, 0.0, 0.0, viewport), None);
    assert_eq!(MapCamera::new(0.0, 0.0, -1075.0, 0.0, 0.0, viewport), None);
}

#[test]
fn north_up_camera_projects_center_to_viewport_center() {
    let viewport = ViewportSize::new(1280.0, 720.0).expect("valid viewport");
    let camera = MapCamera::new(13.405, 52.52, 8.0, 0.0, 0.0, viewport).expect("valid camera");

    let screen = camera
        .project_screen(13.405, 52.52)
        .expect("supported projection");

    assert_near(screen.x, 640.0);
    assert_near(screen.y, 360.0);
}

#[test]
fn north_up_camera_screen_projection_round_trips_across_antimeridian() {
    let viewport = ViewportSize::new(1280.0, 720.0).expect("valid viewport");
    let camera = MapCamera::new(179.9, 0.0, 3.0, 0.0, 0.0, viewport).expect("valid camera");

    let projected = camera
        .project_screen(-179.9, 0.0)
        .expect("supported projection");
    assert!(projected.x > viewport.width / 2.0);

    let geographic = camera
        .unproject_screen(projected)
        .expect("supported unprojection");
    assert_near(geographic.longitude, -179.9);
    assert_near(geographic.latitude, 0.0);
}

#[test]
fn camera_fails_closed_for_unimplemented_bearing_or_pitch_projection() {
    let viewport = ViewportSize::new(800.0, 600.0).expect("valid viewport");
    let bearing = MapCamera::new(0.0, 0.0, 2.0, 10.0, 0.0, viewport).expect("valid camera");
    let pitch = MapCamera::new(0.0, 0.0, 2.0, 0.0, 20.0, viewport).expect("valid camera");

    assert_eq!(bearing.project_screen(0.0, 0.0), None);
    assert_eq!(pitch.project_screen(0.0, 0.0), None);
    assert_eq!(
        pitch.unproject_screen(ScreenCoordinate { x: 400.0, y: 300.0 }),
        None
    );
}

#[test]
fn camera_fails_closed_for_non_finite_screen_input() {
    let viewport = ViewportSize::new(800.0, 600.0).expect("valid viewport");
    let camera = MapCamera::new(0.0, 0.0, 2.0, 0.0, 0.0, viewport).expect("valid camera");

    assert_eq!(
        camera.unproject_screen(ScreenCoordinate {
            x: f64::NAN,
            y: 300.0,
        }),
        None
    );
}

#[test]
fn tile_identity_rejects_noncanonical_coordinates() {
    assert_eq!(TileId::new(0, 0, 0), Some(TileId { z: 0, x: 0, y: 0 }));
    assert_eq!(TileId::new(0, 1, 0), None);
    assert_eq!(TileId::new(2, 3, 3), Some(TileId { z: 2, x: 3, y: 3 }));
    assert_eq!(TileId::new(2, 4, 0), None);
}

#[test]
fn tile_parent_and_children_preserve_xyz_pyramid_identity() {
    let tile = TileId::new(3, 4, 6).expect("valid tile");
    assert_eq!(tile.parent(), TileId::new(2, 2, 3));

    let children = tile.children().expect("representable children");
    assert_eq!(children[0], TileId::new(4, 8, 12).expect("valid child"));
    assert_eq!(children[1], TileId::new(4, 9, 12).expect("valid child"));
    assert_eq!(children[2], TileId::new(4, 8, 13).expect("valid child"));
    assert_eq!(children[3], TileId::new(4, 9, 13).expect("valid child"));
}
