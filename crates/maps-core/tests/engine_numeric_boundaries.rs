use maps_core::{MapCamera, ViewportSize, wrap_longitude};

#[test]
fn canonical_negative_longitude_near_zero_is_preserved_exactly() {
    let longitude = -1e-14;

    assert_eq!(wrap_longitude(longitude), longitude);
}

#[test]
fn canonical_east_antimeridian_adjacent_longitude_is_preserved_exactly() {
    let longitude = 179.999_999_999_999_97;

    assert_eq!(wrap_longitude(longitude), longitude);
}

#[test]
fn almost_antipodal_target_keeps_its_eastward_side() {
    let viewport = ViewportSize::new(1280.0, 720.0).expect("valid viewport");
    let camera = MapCamera::new(-179.93, 0.0, 2.0, 0.0, 0.0, viewport).expect("valid camera");
    let target_longitude = 0.069_999_999_999_992_9;

    let projected = camera
        .project_screen(target_longitude, 0.0)
        .expect("supported projection");

    assert!(
        projected.x > viewport.width / 2.0,
        "target just under 180 degrees east must remain on the eastward world copy"
    );
}
