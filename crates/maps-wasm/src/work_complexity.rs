//! Multi-scale operation work evidence for GPU-retained application points (#155, #189).
//!
//! These tests feed the `operations` in `.performance/contract.json` through
//! `scripts/collect-work-evidence.sh`. They drive the renderer-independent half of the
//! retained point path, [`RetainedPointState`], exactly as the wgpu backend does, with real
//! `maps-core` camera frames ([`FlatRasterRuntime::frame_plan`]) and the shared frame-uniform
//! packing. The backend's GPU instance buffer is mirrored byte for byte by executing the
//! returned [`InstanceUpload`]s, so every counted upload is also an applied one.
//!
//! Each camera frame is checked against an independent oracle before any work is
//! recorded: every sampled point that `maps-core` projects into the viewport must be drawn
//! there by one of the frame uniforms applied to its mirrored instance offset, with its
//! current paint record. Only then are the resource-boundary counters
//! ([`RetainedPointCounters`]) and the executed uploads recorded.
//!
//! When `MAPS_WORK_EVIDENCE_DIR` is set, the tests write `<operation>.json` fragments and
//! leave the declared bounds to `coding-tooling performance work`. Without it, they assert
//! the same bounds themselves (as exact formulas), so plain `cargo test` fails when a camera
//! frame re-encodes or re-uploads retained points, or a feature update rebuilds the group.

use std::path::{Path, PathBuf};

use maps_core::{
    FlatRasterRuntime, FlatRasterRuntimeLimits, MapCamera, RasterSourceSpec, ViewportSize,
};

use crate::retained_frame::{FRAME_UNIFORM_SIZE, LocalFrame, pack_frame_uniforms};
use crate::retained_points::{
    InstanceUpload, REBASE_DISTANCE_PX, RETAINED_POINT_INSTANCE_SIZE, RETAINED_POINT_PAINT_LENGTH,
    RetainedPointCounters, RetainedPointState, RetainedView,
};
use crate::wgpu_geometry::{
    APPLICATION_CIRCLE, APPLICATION_CIRCLE_RECORD_LENGTH, WgpuApplicationFrame,
    prepare_application_geometry,
};

/// One scale point: `(dimensions, metrics)` as `(name, value)` pairs.
type WorkSample = (Vec<(&'static str, u64)>, Vec<(&'static str, u64)>);

/// Static application points at each camera scale point.
const STATIC_FEATURES: [u64; 3] = [1_000, 10_000, 100_000];
/// Changed points of the in-place update operation.
const CHANGED_FEATURES: [u64; 3] = [1, 10, 100];
/// Camera frames of the ordinary pan and zoom/bearing/pitch journeys.
const JOURNEY_FRAMES: u64 = 32;
/// Camera frames and per-frame travel (CSS px) of the deep-zoom pan.
const DEEP_PAN_FRAMES: u64 = 64;
const DEEP_PAN_STEP_PX: f64 = 2_000.0;
const DEEP_PAN_ZOOM: f64 = 15.0;
/// Camera frames of the screen-projected comparison journey.
const PROJECTED_FRAMES: u64 = 8;
const VIEWPORT: [f64; 2] = [800.0, 600.0];
/// WebGPU's default `minUniformBufferOffsetAlignment`: the frame-uniform stride.
const UNIFORM_STRIDE: u64 = 256;
/// Argument bytes per point of `setRetainedPoints`: `f64` longitude and latitude plus the
/// `f32` paint record.
const POINT_BRIDGE_BYTES: u64 = 2 * 8 + RETAINED_POINT_PAINT_LENGTH as u64 * 4;
/// `updateRetainedPoints` additionally takes one `u32` index per changed point.
const UPDATE_BRIDGE_BYTES: u64 = POINT_BRIDGE_BYTES + 4;
/// Largest screen distance (CSS px) between the oracle projection and the drawn centre.
const ORACLE_TOLERANCE_PX: f64 = 0.05;

fn work_evidence_dir() -> Option<PathBuf> {
    std::env::var_os("MAPS_WORK_EVIDENCE_DIR").map(Into::into)
}

fn write_work_evidence(dir: &Path, operation: &str, samples: &[WorkSample]) {
    fn fields(pairs: &[(&str, u64)]) -> String {
        pairs
            .iter()
            .map(|(name, value)| format!("\"{name}\":{value}"))
            .collect::<Vec<_>>()
            .join(",")
    }
    let samples = samples
        .iter()
        .map(|(dimensions, metrics)| {
            format!(
                "{{\"dimensions\":{{{}}},\"metrics\":{{{}}}}}",
                fields(dimensions),
                fields(metrics)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    std::fs::write(
        dir.join(format!("{operation}.json")),
        format!("{{\"id\":\"{operation}\",\"samples\":[{samples}]}}\n"),
    )
    .expect("work evidence directory must be writable");
}

/// Writes the fragment under `MAPS_WORK_EVIDENCE_DIR`; otherwise asserts every bound.
fn report(operation: &str, samples: &[WorkSample], assert_bounds: impl Fn(&WorkSample)) {
    match work_evidence_dir() {
        Some(dir) => write_work_evidence(&dir, operation, samples),
        None => samples.iter().for_each(assert_bounds),
    }
}

fn dimension(sample: &WorkSample, name: &str) -> u64 {
    sample
        .0
        .iter()
        .find(|(dimension, _)| *dimension == name)
        .map(|(_, value)| *value)
        .unwrap_or_else(|| panic!("sample is missing dimension {name}"))
}

fn metric(sample: &WorkSample, name: &str) -> u64 {
    sample
        .1
        .iter()
        .find(|(metric, _)| *metric == name)
        .map(|(_, value)| *value)
        .unwrap_or_else(|| panic!("sample is missing metric {name}"))
}

fn assert_metric(sample: &WorkSample, name: &str, expected: u64) {
    assert_eq!(
        metric(sample, name),
        expected,
        "{name} at {:?} must be {expected}",
        sample.0
    );
}

/// Deterministic SplitMix64 stream in `[0, 1)`.
struct Random(u64);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (z ^ (z >> 31)) as f64 / (1_u64 << 63) as f64 / 2.0
    }
}

/// Paint record of point `index` in data `generation`: radius and stroke width (CSS px),
/// fill RGBA, stroke RGBA.
fn paint_record(index: usize, generation: u32) -> [f32; RETAINED_POINT_PAINT_LENGTH] {
    let tint = (index % 251) as f32 / 251.0;
    [
        3.0 + (index % 5) as f32,
        1.0,
        tint,
        0.5,
        generation as f32 * 0.25,
        1.0,
        0.1,
        0.1,
        0.1,
        1.0,
    ]
}

/// `count` deterministic points inside `[west, east] x [south, north]` (degrees).
fn dataset(count: u64, bounds: [f64; 4], seed: u64) -> (Vec<f64>, Vec<f32>) {
    let [west, south, east, north] = bounds;
    let mut random = Random(seed);
    let mut lon_lat = Vec::with_capacity(count as usize * 2);
    let mut paint = Vec::with_capacity(count as usize * RETAINED_POINT_PAINT_LENGTH);
    for index in 0..count as usize {
        lon_lat.push(west + (east - west) * random.next());
        lon_lat.push(south + (north - south) * random.next());
        paint.extend_from_slice(&paint_record(index, 0));
    }
    (lon_lat, paint)
}

/// The application-data area of the ordinary journeys: wider than the viewport at zoom 5.
const WIDE_BOUNDS: [f64; 4] = [-30.0, -20.0, 30.0, 20.0];

fn runtime(longitude: f64, latitude: f64, zoom: f64) -> FlatRasterRuntime {
    let viewport = ViewportSize::new(VIEWPORT[0], VIEWPORT[1]).expect("viewport");
    let camera = MapCamera::new(longitude, latitude, zoom, 0.0, 0.0, viewport).expect("camera");
    FlatRasterRuntime::new(
        camera,
        RasterSourceSpec::new(0, 22, 256).expect("source"),
        FlatRasterRuntimeLimits::default(),
    )
    .expect("runtime")
}

/// Which mirrored points the oracle checks in one frame.
#[derive(Clone, Copy)]
enum Check {
    /// Every point.
    All,
    /// About a thousand points, rotating with the frame number.
    Sample,
}

/// Work executed for one camera frame or data change, beyond the cumulative counters.
#[derive(Default)]
struct Executed {
    /// Frame uniforms written (one per drawn world copy).
    uniform_frames: u64,
    /// Uniform bytes written at the dynamic-offset stride.
    uniform_bytes: u64,
    /// GPU instance-buffer write calls (a replacement counts as one).
    instance_writes: u64,
    /// Instance slots rewritten in the mirrored GPU buffer.
    instances_written: u64,
    /// Instance slots rewritten that do not belong to a changed point.
    unrelated_instances_written: u64,
    /// Argument bytes of the `setRetainedPoints`/`updateRetainedPoints` calls (typed
    /// arrays copied across the JS/WASM boundary).
    bridge_bytes: u64,
    /// Points the oracle checked inside the viewport.
    checked_points: u64,
}

fn argument_bytes(indices: &[u32], lon_lat: &[f64], paint: &[f32]) -> u64 {
    (size_of_val(indices) + size_of_val(lon_lat) + size_of_val(paint)) as u64
}

/// One retained point group as the wgpu backend holds it: the CPU state, the cumulative
/// counters and a byte mirror of its GPU instance buffer.
struct RetainedGroup {
    counters: RetainedPointCounters,
    state: RetainedPointState,
    instances: Option<Vec<u8>>,
    lon_lat: Vec<f64>,
    paint: Vec<f32>,
    uniforms: Vec<u8>,
}

impl RetainedGroup {
    /// `setRetainedPoints`: lowers a group that is encoded on its first draw.
    fn prepare(lon_lat: Vec<f64>, paint: Vec<f32>) -> Self {
        let mut counters = RetainedPointCounters::default();
        let state = RetainedPointState::prepare(&lon_lat, &paint, &mut counters).expect("prepare");
        Self {
            counters,
            state,
            instances: None,
            lon_lat,
            paint,
            uniforms: Vec::new(),
        }
    }

    /// Replaces the whole group, as `setRetainedPoints` on an existing group does.
    fn replace(&mut self, lon_lat: Vec<f64>, paint: Vec<f32>) -> Executed {
        self.state =
            RetainedPointState::prepare(&lon_lat, &paint, &mut self.counters).expect("replace");
        let executed = Executed {
            bridge_bytes: argument_bytes(&[], &lon_lat, &paint),
            ..Executed::default()
        };
        self.instances = None;
        self.lon_lat = lon_lat;
        self.paint = paint;
        executed
    }

    /// Executes `upload` against the mirrored buffer, like `apply_instance_upload`.
    fn execute(&mut self, upload: InstanceUpload, changed: &[u32], executed: &mut Executed) {
        let size = RETAINED_POINT_INSTANCE_SIZE as usize;
        let mut written = Vec::new();
        match upload {
            InstanceUpload::Replace(bytes) => {
                assert_eq!(
                    bytes.len(),
                    self.state.len() * size,
                    "a replacement holds every point"
                );
                written.extend(0..self.state.len());
                self.instances = (!bytes.is_empty()).then_some(bytes);
                executed.instance_writes += 1;
            }
            InstanceUpload::Patch(runs) => {
                let buffer = self.instances.as_mut().expect("a patch needs instances");
                for (offset, bytes) in runs {
                    let offset = offset as usize;
                    assert!(offset.is_multiple_of(size) && bytes.len().is_multiple_of(size));
                    buffer[offset..offset + bytes.len()].copy_from_slice(&bytes);
                    written.extend(offset / size..(offset + bytes.len()) / size);
                    executed.instance_writes += 1;
                }
            }
        }
        executed.instances_written += written.len() as u64;
        executed.unrelated_instances_written += written
            .iter()
            .filter(|index| changed.binary_search(&(**index as u32)).is_err())
            .count() as u64;
    }

    /// `updateRetainedPoints`: replaces the points at `indices` in place.
    fn update(&mut self, indices: &[u32], lon_lat: &[f64], paint: &[f32]) -> Executed {
        let mut executed = Executed {
            bridge_bytes: argument_bytes(indices, lon_lat, paint),
            ..Executed::default()
        };
        let upload = self
            .state
            .update(indices, lon_lat, paint, &mut self.counters)
            .expect("update");
        for (position, &index) in indices.iter().enumerate() {
            let index = index as usize;
            self.lon_lat[index * 2..index * 2 + 2]
                .copy_from_slice(&lon_lat[position * 2..position * 2 + 2]);
            self.paint[index * RETAINED_POINT_PAINT_LENGTH..][..RETAINED_POINT_PAINT_LENGTH]
                .copy_from_slice(
                    &paint[position * RETAINED_POINT_PAINT_LENGTH..][..RETAINED_POINT_PAINT_LENGTH],
                );
        }
        if let Some(upload) = upload {
            self.execute(upload, indices, &mut executed);
        }
        executed
    }

    /// One camera frame, as `prepare_retained_point_draws` runs it, then the oracle.
    fn frame(&mut self, runtime: &mut FlatRasterRuntime, frame: u64, check: Check) -> Executed {
        let plan = runtime.frame_plan().expect("frame plan");
        let view_projection = plan.render_camera.view_projection;
        let view = RetainedView::from_placements(
            plan.placements.iter().map(|placement| {
                (
                    placement.tile.z,
                    placement.tile.x,
                    placement.tile.y,
                    placement.local_west,
                    placement.local_north,
                    placement.local_size,
                )
            }),
            view_projection,
            VIEWPORT[0],
        )
        .expect("retained view");

        let mut executed = Executed::default();
        if let Some(upload) = self.state.place(&view, &mut self.counters) {
            self.execute(upload, &[], &mut executed);
        }
        let frames: Vec<((), LocalFrame)> =
            self.state.frames(&view).map(|frame| ((), frame)).collect();
        let surface = [VIEWPORT[0] as f32, VIEWPORT[1] as f32, 1.0, 0.0];
        let offsets = pack_frame_uniforms(
            frames,
            view_projection,
            |_| surface,
            UNIFORM_STRIDE,
            &mut self.uniforms,
        );
        executed.uniform_frames = offsets.len() as u64;
        executed.uniform_bytes = self.uniforms.len() as u64;
        executed.checked_points = self.check_oracle(runtime, &offsets, frame, check);
        executed
    }

    /// Every checked point that `maps-core` projects into the viewport is drawn there by a
    /// frame uniform applied to its mirrored instance offset, with its current paint.
    /// Returns the number of points checked inside the viewport.
    fn check_oracle(
        &self,
        runtime: &FlatRasterRuntime,
        offsets: &[((), u32)],
        frame: u64,
        check: Check,
    ) -> u64 {
        let instances = self
            .instances
            .as_deref()
            .expect("a drawn group has instances");
        let size = RETAINED_POINT_INSTANCE_SIZE as usize;
        assert_eq!(instances.len(), self.state.len() * size);
        let read = |bytes: &[u8], index: usize| {
            f32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
        };
        let matrices: Vec<[f32; 16]> = offsets
            .iter()
            .map(|(_, offset)| {
                let uniform = &self.uniforms[*offset as usize..][..FRAME_UNIFORM_SIZE as usize];
                std::array::from_fn(|index| read(uniform, index))
            })
            .collect();
        assert!(!matrices.is_empty(), "a drawn group has at least one frame");
        let count = self.state.len() as u64;
        let (step, start) = match check {
            Check::All => (1, 0),
            Check::Sample => {
                let step = (count / 1_000).max(1);
                (step, frame % step)
            }
        };
        let mut checked = 0;
        for index in (start..count).step_by(step as usize) {
            let index = index as usize;
            let (longitude, latitude) = (self.lon_lat[index * 2], self.lon_lat[index * 2 + 1]);
            let Ok(expected) = runtime.project_screen(longitude, latitude) else {
                continue;
            };
            if !(0.0..=VIEWPORT[0]).contains(&expected.x)
                || !(0.0..=VIEWPORT[1]).contains(&expected.y)
            {
                continue;
            }
            let instance = &instances[index * size..(index + 1) * size];
            let offset = [f64::from(read(instance, 0)), f64::from(read(instance, 1))];
            let paint: Vec<f32> = (0..RETAINED_POINT_PAINT_LENGTH)
                .map(|value| read(instance, 2 + value))
                .collect();
            assert_eq!(
                paint,
                self.paint[index * RETAINED_POINT_PAINT_LENGTH..][..RETAINED_POINT_PAINT_LENGTH],
                "point {index} must carry its current paint"
            );
            let distance = matrices
                .iter()
                .filter_map(|matrix| {
                    let m = matrix.map(f64::from);
                    let x = m[0] * offset[0] + m[4] * offset[1] + m[12];
                    let y = m[1] * offset[0] + m[5] * offset[1] + m[13];
                    let w = m[3] * offset[0] + m[7] * offset[1] + m[15];
                    (w > 0.0).then(|| {
                        let screen_x = (x / w + 1.0) * 0.5 * VIEWPORT[0];
                        let screen_y = (1.0 - y / w) * 0.5 * VIEWPORT[1];
                        (screen_x - expected.x).hypot(screen_y - expected.y)
                    })
                })
                .fold(f64::INFINITY, f64::min);
            assert!(
                distance <= ORACLE_TOLERANCE_PX,
                "point {index} is drawn {distance} px from its maps-core projection in frame {frame}"
            );
            checked += 1;
        }
        checked
    }
}

/// Counter and executed-work deltas of one measured phase.
struct Phase {
    before: RetainedPointCounters,
    executed: Executed,
}

impl Phase {
    fn start(group: &RetainedGroup) -> Self {
        Self {
            before: group.counters,
            executed: Executed::default(),
        }
    }

    fn add(&mut self, executed: Executed) {
        let total = &mut self.executed;
        total.uniform_frames += executed.uniform_frames;
        total.uniform_bytes += executed.uniform_bytes;
        total.instance_writes += executed.instance_writes;
        total.instances_written += executed.instances_written;
        total.unrelated_instances_written += executed.unrelated_instances_written;
        total.bridge_bytes += executed.bridge_bytes;
        total.checked_points += executed.checked_points;
    }

    /// Resource-boundary counter deltas, cross-checked against the executed uploads.
    fn metrics(&self, group: &RetainedGroup) -> Vec<(&'static str, u64)> {
        let after = group.counters;
        let encoded = after.encoded - self.before.encoded;
        let upload_bytes = after.upload_bytes - self.before.upload_bytes;
        // The counters describe exactly the uploads the backend executed.
        assert_eq!(encoded, self.executed.instances_written);
        assert_eq!(upload_bytes, encoded * RETAINED_POINT_INSTANCE_SIZE);
        vec![
            (
                "prepared-coordinates",
                after.prepared - self.before.prepared,
            ),
            ("encoded-instances", encoded),
            ("instance-upload-bytes", upload_bytes),
            ("instance-rebuilds", after.rebases - self.before.rebases),
            ("instance-write-calls", self.executed.instance_writes),
            ("frame-uniform-writes", self.executed.uniform_frames),
            ("frame-uniform-bytes", self.executed.uniform_bytes),
        ]
    }
}

/// Prepares `count` wide-area points and draws the first frame (the initial encode).
fn warm_group(count: u64, runtime: &mut FlatRasterRuntime) -> RetainedGroup {
    let (lon_lat, paint) = dataset(count, WIDE_BOUNDS, 0x5EED_0189);
    let mut group = RetainedGroup::prepare(lon_lat, paint);
    let first = group.frame(runtime, 0, Check::All);
    assert_eq!(
        group.counters.rebases, 1,
        "the first draw encodes the group once"
    );
    assert!(
        first.checked_points > 0,
        "the oracle must see points in the first frame"
    );
    group
}

/// Runs a camera journey over unchanged data; `step` moves the camera for frame `k`.
fn camera_journey(
    count: u64,
    mut runtime: FlatRasterRuntime,
    frames: u64,
    step: impl Fn(&mut FlatRasterRuntime, u64),
) -> WorkSample {
    let mut group = warm_group(count, &mut runtime);
    let mut phase = Phase::start(&group);
    for frame in 1..=frames {
        step(&mut runtime, frame);
        let check = if frame == frames {
            Check::All
        } else {
            Check::Sample
        };
        phase.add(group.frame(&mut runtime, frame, check));
    }
    assert!(
        phase.executed.checked_points >= frames,
        "the oracle must check visible points throughout the journey"
    );
    (vec![("staticFeatures", count)], phase.metrics(&group))
}

/// Ordinary camera frames encode, lower and upload nothing and write one frame uniform
/// per frame (one world copy at these zooms).
fn assert_ordinary_camera_bounds(sample: &WorkSample) {
    for name in [
        "prepared-coordinates",
        "encoded-instances",
        "instance-upload-bytes",
        "instance-rebuilds",
        "instance-write-calls",
    ] {
        assert_metric(sample, name, 0);
    }
    assert_metric(sample, "frame-uniform-writes", JOURNEY_FRAMES);
    assert_metric(
        sample,
        "frame-uniform-bytes",
        JOURNEY_FRAMES * UNIFORM_STRIDE,
    );
}

#[test]
fn retained_points_camera_pan_does_no_per_point_work() {
    let samples: Vec<WorkSample> = STATIC_FEATURES
        .iter()
        .map(|&count| {
            camera_journey(
                count,
                runtime(0.0, 0.0, 5.0),
                JOURNEY_FRAMES,
                |runtime, _| {
                    runtime.pan_by_pixels(37.0, -23.0).expect("pan");
                },
            )
        })
        .collect();
    report(
        "retained-points-camera-pan",
        &samples,
        assert_ordinary_camera_bounds,
    );
}

#[test]
fn retained_points_camera_zoom_rotate_pitch_does_no_per_point_work() {
    let samples: Vec<WorkSample> = STATIC_FEATURES
        .iter()
        .map(|&count| {
            camera_journey(
                count,
                runtime(2.0, 1.0, 5.0),
                JOURNEY_FRAMES,
                |runtime, frame| {
                    let k = frame as f64;
                    runtime
                        .set_camera_state(2.0, 1.0, 5.0 + k * 0.1, k * 4.0, (k * 2.0).min(60.0))
                        .expect("camera");
                },
            )
        })
        .collect();
    report(
        "retained-points-camera-zoom-rotate-pitch",
        &samples,
        assert_ordinary_camera_bounds,
    );
}

/// Frames between deep-pan rebases: the first frame whose travel exceeds the distance.
const DEEP_PAN_FRAMES_PER_REBASE: u64 = (REBASE_DISTANCE_PX / DEEP_PAN_STEP_PX) as u64 + 1;
/// Deterministic rebases of the deep-zoom pan journey after the initial encode.
const DEEP_PAN_REBASES: u64 = DEEP_PAN_FRAMES / DEEP_PAN_FRAMES_PER_REBASE;

#[test]
fn retained_points_deep_pan_rebases_are_counted_and_bounded_by_travel() {
    let travel_degrees =
        DEEP_PAN_STEP_PX * DEEP_PAN_FRAMES as f64 / 256.0 / DEEP_PAN_ZOOM.exp2() * 360.0;
    let samples: Vec<WorkSample> = STATIC_FEATURES
        .iter()
        .map(|&count| {
            // A band along the pan path, so the deep-zoom viewport always holds points.
            let (lon_lat, paint) = dataset(
                count,
                [
                    10.0 - 0.05,
                    5.0 - 0.01,
                    10.0 + travel_degrees + 0.05,
                    5.0 + 0.01,
                ],
                0x0DEE_9189,
            );
            let mut runtime = runtime(10.0, 5.0, DEEP_PAN_ZOOM);
            let mut group = RetainedGroup::prepare(lon_lat, paint);
            group.frame(&mut runtime, 0, Check::All);
            let mut phase = Phase::start(&group);
            for frame in 1..=DEEP_PAN_FRAMES {
                runtime.pan_by_pixels(-DEEP_PAN_STEP_PX, 0.0).expect("pan");
                let check = if frame % DEEP_PAN_FRAMES_PER_REBASE == 0 {
                    Check::All
                } else {
                    Check::Sample
                };
                phase.add(group.frame(&mut runtime, frame, check));
            }
            assert!(phase.executed.checked_points >= DEEP_PAN_FRAMES);
            (vec![("staticFeatures", count)], phase.metrics(&group))
        })
        .collect();
    report(
        "retained-points-camera-deep-pan-rebase",
        &samples,
        |sample| {
            let count = dimension(sample, "staticFeatures");
            assert_metric(sample, "prepared-coordinates", 0);
            assert_metric(sample, "instance-rebuilds", DEEP_PAN_REBASES);
            assert_metric(sample, "instance-write-calls", DEEP_PAN_REBASES);
            assert_metric(sample, "encoded-instances", DEEP_PAN_REBASES * count);
            assert_metric(
                sample,
                "instance-upload-bytes",
                DEEP_PAN_REBASES * count * RETAINED_POINT_INSTANCE_SIZE,
            );
            assert_metric(sample, "frame-uniform-writes", DEEP_PAN_FRAMES);
            assert_metric(
                sample,
                "frame-uniform-bytes",
                DEEP_PAN_FRAMES * UNIFORM_STRIDE,
            );
        },
    );
}

#[test]
fn retained_points_update_rewrites_only_the_changed_points() {
    let mut samples = Vec::new();
    for &count in &STATIC_FEATURES {
        for &changed in &CHANGED_FEATURES {
            let mut runtime = runtime(0.0, 0.0, 5.0);
            let mut group = warm_group(count, &mut runtime);
            // Spread over the group so no two changed points share a run.
            let stride = count / changed;
            let indices: Vec<u32> = (0..changed)
                .map(|k| (k * stride + stride / 2) as u32)
                .collect();
            let mut lon_lat = Vec::new();
            let mut paint = Vec::new();
            for &index in &indices {
                let index = index as usize;
                lon_lat.push(group.lon_lat[index * 2] + 0.5);
                lon_lat.push(group.lon_lat[index * 2 + 1] - 0.25);
                paint.extend_from_slice(&paint_record(index, 1));
            }

            let mut phase = Phase::start(&group);
            phase.add(group.update(&indices, &lon_lat, &paint));
            // The next camera frame draws the moved points with every other point intact.
            runtime.pan_by_pixels(5.0, 3.0).expect("pan");
            phase.add(group.frame(&mut runtime, 1, Check::All));
            let mut metrics = phase.metrics(&group);
            metrics.push((
                "unrelated-instances-written",
                phase.executed.unrelated_instances_written,
            ));
            metrics.push(("bridge-bytes", phase.executed.bridge_bytes));
            samples.push((
                vec![("changedFeatures", changed), ("totalFeatures", count)],
                metrics,
            ));
        }
    }
    report("retained-points-update-features", &samples, |sample| {
        let changed = dimension(sample, "changedFeatures");
        assert_metric(sample, "prepared-coordinates", changed);
        assert_metric(sample, "encoded-instances", changed);
        assert_metric(
            sample,
            "instance-upload-bytes",
            changed * RETAINED_POINT_INSTANCE_SIZE,
        );
        assert_metric(sample, "instance-write-calls", changed);
        assert_metric(sample, "instance-rebuilds", 0);
        assert_metric(sample, "unrelated-instances-written", 0);
        assert_metric(sample, "frame-uniform-writes", 1);
        assert_metric(sample, "frame-uniform-bytes", UNIFORM_STRIDE);
        assert_metric(sample, "bridge-bytes", changed * UPDATE_BRIDGE_BYTES);
    });
}

#[test]
fn retained_points_dataset_replacement_is_declared_linear_work() {
    let samples: Vec<WorkSample> = STATIC_FEATURES
        .iter()
        .map(|&count| {
            let mut runtime = runtime(0.0, 0.0, 5.0);
            let mut group = warm_group(count, &mut runtime);
            let (lon_lat, paint) = dataset(count, WIDE_BOUNDS, 0x0E91_ACE0);
            let mut phase = Phase::start(&group);
            phase.add(group.replace(lon_lat, paint));
            phase.add(group.frame(&mut runtime, 1, Check::All));
            let mut metrics = phase.metrics(&group);
            metrics.push(("bridge-bytes", phase.executed.bridge_bytes));
            (vec![("features", count)], metrics)
        })
        .collect();
    report("retained-points-replace-dataset", &samples, |sample| {
        let count = dimension(sample, "features");
        assert_metric(sample, "prepared-coordinates", count);
        assert_metric(sample, "encoded-instances", count);
        assert_metric(
            sample,
            "instance-upload-bytes",
            count * RETAINED_POINT_INSTANCE_SIZE,
        );
        assert_metric(sample, "instance-rebuilds", 1);
        assert_metric(sample, "instance-write-calls", 1);
        assert_metric(sample, "frame-uniform-writes", 1);
        assert_metric(sample, "frame-uniform-bytes", UNIFORM_STRIDE);
        assert_metric(sample, "bridge-bytes", count * POINT_BRIDGE_BYTES);
    });
}

/// The screen-projected application path that retained points replace (the path before
/// #155, still used where retention is unavailable): every camera frame projects every
/// point through `maps-core`, sends one packed circle record per point across the
/// boundary and re-encodes and uploads one circle instance per point.
#[test]
fn projected_points_camera_pan_is_the_linear_comparison_path() {
    let samples: Vec<WorkSample> = STATIC_FEATURES
        .iter()
        .map(|&count| {
            let (lon_lat, paint) = dataset(count, WIDE_BOUNDS, 0x5EED_0189);
            let coordinates: Vec<[f64; 2]> = lon_lat.as_chunks::<2>().0.to_vec();
            let mut runtime = runtime(0.0, 0.0, 5.0);
            let (mut projected, mut bridge_bytes, mut upload_bytes) = (0_u64, 0_u64, 0_u64);
            for frame in 1..=PROJECTED_FRAMES {
                runtime.pan_by_pixels(37.0, -23.0).expect("pan");
                let mut circle_data =
                    Vec::with_capacity(coordinates.len() * APPLICATION_CIRCLE_RECORD_LENGTH);
                for (index, screen) in runtime.project_screen_batch(&coordinates).enumerate() {
                    let screen = screen.expect("flat projection");
                    projected += 1;
                    let record = &paint[index * RETAINED_POINT_PAINT_LENGTH..]
                        [..RETAINED_POINT_PAINT_LENGTH];
                    circle_data.extend_from_slice(&[screen.x as f32, screen.y as f32]);
                    circle_data.extend_from_slice(record);
                }
                let mut application = WgpuApplicationFrame {
                    circle_data: Vec::new(),
                    circle_offset: 0.0,
                    direction_markers: Vec::new(),
                    height: VIEWPORT[1],
                    lines: Vec::new(),
                    order: Vec::new(),
                    polygons: Vec::new(),
                    width: VIEWPORT[0],
                };
                application
                    .attach_packed(&circle_data, &[APPLICATION_CIRCLE, 0, count as u32])
                    .expect("packed circles");
                bridge_bytes += circle_data.len() as u64 * 4;
                let geometry =
                    prepare_application_geometry(&application, 1.0, None).expect("geometry");
                upload_bytes += geometry.circle_instances.len() as u64;
                // Oracle: the packed centre is the maps-core projection.
                let index = (frame as usize * 7_919) % coordinates.len();
                let circle = application.circle(index).expect("circle");
                let expected = runtime
                    .project_screen(coordinates[index][0], coordinates[index][1])
                    .expect("projection");
                assert!(
                    (circle.x - expected.x).abs() < 0.01 && (circle.y - expected.y).abs() < 0.01
                );
            }
            (
                vec![("staticFeatures", count)],
                vec![
                    ("projected-coordinates", projected),
                    ("circle-bridge-bytes", bridge_bytes),
                    ("circle-upload-bytes", upload_bytes),
                ],
            )
        })
        .collect();
    report("projected-points-camera-pan", &samples, |sample| {
        let count = dimension(sample, "staticFeatures");
        assert_metric(sample, "projected-coordinates", PROJECTED_FRAMES * count);
        assert_metric(
            sample,
            "circle-bridge-bytes",
            PROJECTED_FRAMES * count * APPLICATION_CIRCLE_RECORD_LENGTH as u64 * 4,
        );
        assert!(metric(sample, "circle-upload-bytes") >= PROJECTED_FRAMES * count);
    });
}
