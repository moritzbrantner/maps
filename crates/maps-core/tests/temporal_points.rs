use maps_core::{TemporalPointKeyframe, TemporalPointSample, TemporalPointTrackIndex};

fn frame(time: f64, longitude: f64, latitude: f64) -> TemporalPointKeyframe {
    TemporalPointKeyframe {
        time,
        longitude,
        latitude,
        visible: true,
    }
}

fn hidden(time: f64, longitude: f64, latitude: f64) -> TemporalPointKeyframe {
    TemporalPointKeyframe {
        visible: false,
        ..frame(time, longitude, latitude)
    }
}

#[test]
fn samples_keyframes_interpolation_and_hold_by_supplied_frame_number() {
    // Declared out of order: frame numbers stay the supplied ones.
    let index = TemporalPointTrackIndex::new([vec![
        frame(90.0, 80.0, 0.0),
        frame(10.0, 5.0, 5.0),
        frame(50.0, 40.0, 40.0),
    ]]);

    assert_eq!(index.time_range(), Some((10.0, 90.0)));
    assert_eq!(index.sample(9.999), vec![TemporalPointSample::Absent]);
    assert_eq!(
        index.sample(50.0),
        vec![TemporalPointSample::Keyframe {
            frame: 2,
            longitude: 40.0,
            latitude: 40.0
        }]
    );
    assert_eq!(
        index.sample(30.0),
        vec![TemporalPointSample::Interpolated {
            previous: 1,
            next: 2,
            progress: 0.5,
            longitude: 22.5,
            latitude: 22.5
        }]
    );
    assert_eq!(
        index.sample(1e9),
        vec![TemporalPointSample::Keyframe {
            frame: 0,
            longitude: 80.0,
            latitude: 0.0
        }]
    );
    assert_eq!(index.sample(f64::NAN), vec![TemporalPointSample::Absent]);
    assert_eq!(
        index.sample(f64::INFINITY),
        vec![TemporalPointSample::Absent]
    );
}

#[test]
fn duplicate_times_jump_to_the_keyframe_declared_last() {
    let index = TemporalPointTrackIndex::new([vec![
        frame(0.0, 0.0, 0.0),
        frame(40.0, 10.0, 10.0),
        frame(40.0, 50.0, -20.0),
        frame(80.0, 90.0, -20.0),
    ]]);

    assert_eq!(
        index.sample(40.0),
        vec![TemporalPointSample::Keyframe {
            frame: 2,
            longitude: 50.0,
            latitude: -20.0
        }]
    );
    assert!(matches!(
        index.sample(20.0)[0],
        TemporalPointSample::Interpolated {
            previous: 0,
            next: 1,
            ..
        }
    ));
    assert!(matches!(
        index.sample(60.0)[0],
        TemporalPointSample::Interpolated {
            previous: 2,
            next: 3,
            ..
        }
    ));
}

#[test]
fn invisible_keyframes_open_gaps_and_invalid_keyframes_are_dropped() {
    let index = TemporalPointTrackIndex::new([
        vec![
            frame(0.0, 1.0, 1.0),
            hidden(30.0, 2.0, 2.0),
            frame(50.0, 3.0, 3.0),
            hidden(70.0, 4.0, 4.0),
        ],
        vec![
            frame(f64::NAN, 1.0, 1.0),
            frame(10.0, 12.0, 11.0),
            frame(50.0, 50.0, f64::INFINITY),
            frame(90.0, 28.0, 19.0),
        ],
        vec![],
    ]);
    let visible = |time| index.sample(time)[0] != TemporalPointSample::Absent;

    assert_eq!(
        [0.0, 29.999, 30.0, 40.0, 50.0, 69.999, 70.0, 100.0].map(visible),
        [true, true, false, false, true, true, false, false]
    );
    assert_eq!(
        index.sample(50.0)[1],
        TemporalPointSample::Interpolated {
            previous: 1,
            next: 3,
            progress: 0.5,
            longitude: 20.0,
            latitude: 15.0
        }
    );
    assert_eq!(index.sample(50.0)[2], TemporalPointSample::Absent);
    assert_eq!(index.time_range(), Some((0.0, 90.0)));
    assert_eq!(
        TemporalPointTrackIndex::new([vec![frame(0.0, f64::NAN, 0.0)]]).time_range(),
        None
    );
}

#[test]
fn longitudes_interpolate_as_supplied_across_the_antimeridian() {
    let index = TemporalPointTrackIndex::new([
        vec![frame(0.0, 170.0, 0.0), frame(100.0, 190.0, 0.0)],
        vec![frame(0.0, 170.0, 0.0), frame(100.0, -170.0, 0.0)],
    ]);
    let longitudes = |time| {
        index
            .sample(time)
            .into_iter()
            .map(|sample| match sample {
                TemporalPointSample::Interpolated { longitude, .. } => longitude,
                other => panic!("expected interpolation, got {other:?}"),
            })
            .collect::<Vec<_>>()
    };

    assert_eq!(longitudes(75.0), vec![185.0, -85.0]);
}

#[test]
fn packed_input_and_output_round_trip() {
    let index = TemporalPointTrackIndex::from_packed(
        &[
            0.0, 20.0, 10.0, 1.0, //
            100.0, 60.0, 30.0, 1.0, //
            5.0, 1.0, 2.0, 0.0,
        ],
        &[2, 0, 1],
    )
    .expect("packed tracks");

    assert_eq!(index.track_count(), 3);
    assert_eq!(
        index.sample_packed(25.0),
        vec![
            2.0, 0.0, 1.0, 0.25, 30.0, 15.0, //
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ]
    );
    assert!(TemporalPointTrackIndex::from_packed(&[0.0, 1.0, 2.0], &[1]).is_err());
    assert!(TemporalPointTrackIndex::from_packed(&[0.0, 1.0, 2.0, 1.0], &[2]).is_err());
}
