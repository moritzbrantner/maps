import {
  demoTimelineGeographyCount,
  demoTimelineKeyframeCount,
  demoTracks,
} from "../data/demo-timeline";

export function TimelineSummaryPanel() {
  return (
    <div className="demo-layer-manager" aria-label="Timeline route summary">
      <div className="demo-layer-manager__header">
        <h2>Timeline</h2>
      </div>
      <dl className="demo-editor-facts">
        <div>
          <dt>Routes</dt>
          <dd>{demoTracks.length}</dd>
        </div>
        <div>
          <dt>Geographies</dt>
          <dd>{demoTimelineGeographyCount}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>08:00-10:00</dd>
        </div>
        <div>
          <dt>Keyframes</dt>
          <dd>{demoTimelineKeyframeCount}</dd>
        </div>
      </dl>
    </div>
  );
}
