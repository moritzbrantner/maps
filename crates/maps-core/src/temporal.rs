//! Moving point tracks on the Map-Scoped Timeline (#172).
//!
//! Maps owns where a temporal Map Feature is at a sampled time: which keyframes bracket the
//! time, whether the feature is admitted, and its interpolated geographic position. The
//! TypeScript caller keeps the application data (identity, labels, properties, metrics) and
//! joins it to the source keyframes this index reports.
//!
//! The policy matches `src/temporal-points.ts`, which remains the reference implementation:
//!
//! - keyframes with a non-finite time, longitude or latitude are dropped;
//! - the rest are ordered by time, keeping declaration order for equal times;
//! - before the first keyframe a track is absent; after the last one it holds that keyframe;
//! - of several keyframes at the same time, the one declared last is in effect, so a duplicate
//!   time is an instantaneous jump;
//! - an invisible keyframe hides the track until the next keyframe;
//! - between keyframes the longitude and latitude are linear in time, as supplied (an
//!   unwrapped longitude crosses the antimeridian; a wrapped one does not).

use std::cmp::Ordering;

/// The values per keyframe in [`TemporalPointTrackIndex::from_packed`]'s input.
pub const TEMPORAL_POINT_KEYFRAME_STRIDE: usize = 4;
/// The values per track in [`TemporalPointTrackIndex::sample_packed`]'s output.
pub const TEMPORAL_POINT_SAMPLE_STRIDE: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TemporalPointKeyframe {
    pub time: f64,
    pub longitude: f64,
    pub latitude: f64,
    pub visible: bool,
}

/// A track's state at one sampled time. Frame numbers index the track's keyframes as supplied.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TemporalPointSample {
    /// Not admitted at this time.
    Absent,
    /// Exactly on, or held after, the keyframe `frame`.
    Keyframe {
        frame: usize,
        longitude: f64,
        latitude: f64,
    },
    /// Moving from `previous` towards `next`; `progress` is in `(0, 1)`.
    Interpolated {
        previous: usize,
        next: usize,
        progress: f64,
        longitude: f64,
        latitude: f64,
    },
}

#[derive(Clone, Debug, Default)]
struct PreparedTrack {
    /// Valid keyframes in time order.
    times: Vec<f64>,
    longitudes: Vec<f64>,
    latitudes: Vec<f64>,
    visible: Vec<bool>,
    /// The supplied keyframe number of each prepared keyframe.
    sources: Vec<usize>,
}

/// Prepared moving point tracks. Preparation happens once per source; sampling a time is a
/// binary search per track and does not depend on earlier samples.
#[derive(Clone, Debug, Default)]
pub struct TemporalPointTrackIndex {
    tracks: Vec<PreparedTrack>,
    time_range: Option<(f64, f64)>,
}

impl TemporalPointTrackIndex {
    pub fn new<T, F>(tracks: T) -> Self
    where
        T: IntoIterator<Item = F>,
        F: IntoIterator<Item = TemporalPointKeyframe>,
    {
        let mut start = f64::INFINITY;
        let mut end = f64::NEG_INFINITY;
        let tracks = tracks
            .into_iter()
            .map(|frames| {
                let mut valid: Vec<(usize, TemporalPointKeyframe)> = frames
                    .into_iter()
                    .enumerate()
                    .filter(|(_, frame)| {
                        frame.time.is_finite()
                            && frame.longitude.is_finite()
                            && frame.latitude.is_finite()
                    })
                    .collect();
                // Stable, and -0 and 0 compare equal, like the reference's `left.time - right.time`.
                valid.sort_by(|(_, left), (_, right)| {
                    left.time
                        .partial_cmp(&right.time)
                        .unwrap_or(Ordering::Equal)
                });

                let mut track = PreparedTrack::default();
                for (source, frame) in valid {
                    start = start.min(frame.time);
                    end = end.max(frame.time);
                    track.times.push(frame.time);
                    track.longitudes.push(frame.longitude);
                    track.latitudes.push(frame.latitude);
                    track.visible.push(frame.visible);
                    track.sources.push(source);
                }
                track
            })
            .collect();

        Self {
            tracks,
            time_range: (start <= end).then_some((start, end)),
        }
    }

    /// Builds the index from `[time, longitude, latitude, visible]` per keyframe, all tracks
    /// concatenated, and the number of keyframes of each track. `visible` is `0` for an
    /// invisible keyframe; any other value is visible.
    pub fn from_packed(keyframes: &[f64], frame_counts: &[u32]) -> Result<Self, &'static str> {
        let (keyframes, rest) = keyframes.as_chunks::<TEMPORAL_POINT_KEYFRAME_STRIDE>();
        if !rest.is_empty() {
            return Err("temporal keyframes must have four values each");
        }

        let total = frame_counts
            .iter()
            .try_fold(0usize, |total, count| total.checked_add(*count as usize))
            .ok_or("temporal frame counts overflow")?;
        if total != keyframes.len() {
            return Err("temporal frame counts do not match the keyframes");
        }

        let mut offset = 0;
        Ok(Self::new(frame_counts.iter().map(|count| {
            let range = offset..offset + *count as usize;
            offset = range.end;
            keyframes[range]
                .iter()
                .map(
                    |&[time, longitude, latitude, visible]| TemporalPointKeyframe {
                        time,
                        longitude,
                        latitude,
                        visible: visible != 0.0,
                    },
                )
        })))
    }

    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// The earliest and latest valid keyframe time, visible or not.
    pub fn time_range(&self) -> Option<(f64, f64)> {
        self.time_range
    }

    pub fn sample(&self, time: f64) -> Vec<TemporalPointSample> {
        self.tracks
            .iter()
            .map(|track| sample_track(track, time))
            .collect()
    }

    /// [`Self::sample`] as `[kind, previous, next, progress, longitude, latitude]` per track:
    /// kind `0` is absent (all other values `0`), `1` a keyframe (`next` and `progress` are
    /// `0`) and `2` an interpolated position.
    pub fn sample_packed(&self, time: f64) -> Vec<f64> {
        let mut packed = Vec::with_capacity(self.tracks.len() * TEMPORAL_POINT_SAMPLE_STRIDE);
        for sample in self.tracks.iter().map(|track| sample_track(track, time)) {
            packed.extend_from_slice(&match sample {
                TemporalPointSample::Absent => [0.0; TEMPORAL_POINT_SAMPLE_STRIDE],
                TemporalPointSample::Keyframe {
                    frame,
                    longitude,
                    latitude,
                } => [1.0, frame as f64, 0.0, 0.0, longitude, latitude],
                TemporalPointSample::Interpolated {
                    previous,
                    next,
                    progress,
                    longitude,
                    latitude,
                } => [
                    2.0,
                    previous as f64,
                    next as f64,
                    progress,
                    longitude,
                    latitude,
                ],
            });
        }
        packed
    }
}

fn sample_track(track: &PreparedTrack, time: f64) -> TemporalPointSample {
    if !time.is_finite() {
        return TemporalPointSample::Absent;
    }

    // The first keyframe after `time`; the one before it is in effect.
    let after = track.times.partition_point(|keyframe| *keyframe <= time);
    if after == 0 {
        return TemporalPointSample::Absent;
    }

    let previous = after - 1;
    if !track.visible[previous] {
        return TemporalPointSample::Absent;
    }

    if after == track.times.len() || track.times[previous] == time {
        return TemporalPointSample::Keyframe {
            frame: track.sources[previous],
            longitude: track.longitudes[previous],
            latitude: track.latitudes[previous],
        };
    }

    let progress = (time - track.times[previous]) / (track.times[after] - track.times[previous]);
    TemporalPointSample::Interpolated {
        previous: track.sources[previous],
        next: track.sources[after],
        progress,
        longitude: interpolate(
            track.longitudes[previous],
            track.longitudes[after],
            progress,
        ),
        latitude: interpolate(track.latitudes[previous], track.latitudes[after], progress),
    }
}

/// `left + (right - left) * progress`, unfused, exactly as the reference computes it.
fn interpolate(left: f64, right: f64, progress: f64) -> f64 {
    left + (right - left) * progress
}
