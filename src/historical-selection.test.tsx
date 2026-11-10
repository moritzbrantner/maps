import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  createMapScopedTimelineClock,
  getHistoricalMapFeatureDateOptions,
  HistoricalMapFeatureContextPanel,
  isHistoricalMapFeatureApplicable,
  resolveHistoricalMapFeatureName,
  useHistoricalMapFeatureSelection,
  type HistoricalMapFeatureRecord,
  type MapScopedTimelineClock,
} from ".";

/** Illustrative, synthetic records: not historical evidence. */
const HARBOUR: HistoricalMapFeatureRecord = {
  attribution: "Synthetic fixture",
  id: "harbour",
  modernName: "Modern Harbourtown",
  names: [
    {
      end: 1850,
      localized: { de: "Althafen", en: "Old Harbour" },
      original: { language: "la", text: "Portus Vetus" },
      start: 1800,
    },
    { end: 1900, localized: { en: "New Harbour" }, original: { language: "de", text: "Neuhafen" }, start: 1850 },
  ],
  periods: [{ end: 1900, label: "1800–1899", start: 1800 }],
  supportedDates: [
    { label: "1820", time: 1820 },
    { label: "1860", time: 1860 },
    { label: "1950", time: 1950 },
  ],
};
const MILL: HistoricalMapFeatureRecord = {
  id: "mill",
  periods: [{ start: 1880 }],
};
const RECORDS = [HARBOUR, MILL];

describe("historical Map Feature records", () => {
  test("periods are start-inclusive and end-exclusive; open periods never end", () => {
    expect(isHistoricalMapFeatureApplicable(HARBOUR, 1800)).toBe(true);
    expect(isHistoricalMapFeatureApplicable(HARBOUR, 1899.9)).toBe(true);
    expect(isHistoricalMapFeatureApplicable(HARBOUR, 1900)).toBe(false);
    expect(isHistoricalMapFeatureApplicable(MILL, 1879)).toBe(false);
    expect(isHistoricalMapFeatureApplicable(MILL, 5000)).toBe(true);
  });

  test("names follow the date and the viewer language, flagging the source-form fallback", () => {
    expect(resolveHistoricalMapFeatureName(HARBOUR, 1820, "en")).toMatchObject({
      language: "en",
      modernName: "Modern Harbourtown",
      sourceFormFallback: false,
      text: "Old Harbour",
    });
    expect(resolveHistoricalMapFeatureName(HARBOUR, 1820, "de-AT")?.text).toBe("Althafen");
    expect(resolveHistoricalMapFeatureName(HARBOUR, 1860, "en")?.text).toBe("New Harbour");
    expect(resolveHistoricalMapFeatureName(HARBOUR, 1860, "es")).toMatchObject({
      language: "de",
      sourceFormFallback: true,
      text: "Neuhafen",
    });
    expect(resolveHistoricalMapFeatureName(HARBOUR, 1950, "en")).toBeNull();
  });

  test("mini-timeline options say honestly which dates the map can show the feature at", () => {
    expect(getHistoricalMapFeatureDateOptions(HARBOUR, { end: 1920, start: 1800 }, 10)).toEqual([
      { available: true, label: "1820", sampledTime: 1820, time: 1820 },
      { available: true, label: "1860", sampledTime: 1860, time: 1860 },
      { available: false, label: "1950", reason: "outside-timeline", sampledTime: 1950, time: 1950 },
    ]);
    const coarse = getHistoricalMapFeatureDateOptions(
      { ...HARBOUR, periods: [{ end: 1900, start: 1855 }], supportedDates: [{ time: 1860 }] },
      { end: 1920, start: 1800 },
      50,
    );
    expect(coarse).toEqual([
      { available: false, reason: "out-of-period-at-snapped-time", sampledTime: 1850, time: 1860 },
    ]);
  });
});

function HistoricalHarness({ clock, locale = "en" }: { clock: MapScopedTimelineClock; locale?: string }) {
  const selection = useHistoricalMapFeatureSelection<{ id: string }>({
    features: RECORDS,
    locale,
    timeline: clock,
  });

  return (
    <>
      <ul aria-label="Places at this date">
        {RECORDS.filter((record) => selection.isFeatureApplicable(record.id)).map((record) => (
          <li key={record.id}>
            <button
              aria-pressed={selection.selectedFeatureId === record.id}
              onClick={() => selection.selectFeature(record.id, { id: record.id })}
              onMouseEnter={() => selection.onHoveredFeatureIdChange(record.id)}
              type="button"
            >
              {selection.getFeatureName(record.id)?.text ?? record.id}
            </button>
          </li>
        ))}
      </ul>
      <output data-testid="selected">{selection.selectedFeatureId ?? "none"}</output>
      <output data-testid="hovered">{selection.hoveredFeatureId ?? "none"}</output>
      {selection.selectedFeatureId ? (
        <div data-testid="popup">{selection.getFeatureName(selection.selectedFeatureId)?.text}</div>
      ) : null}
      <HistoricalMapFeatureContextPanel
        renderDetails={(context) => <p>Consumer details for {context.featureId}</p>}
        selection={selection}
      />
    </>
  );
}

function createHistoryClock() {
  return createMapScopedTimelineClock({ defaultTime: 1820, timeRange: { end: 1920, start: 1800 } });
}

describe("useHistoricalMapFeatureSelection (Decisions 1.14/1.16/1.18/1.20)", () => {
  test("leaving the period clears selection, hover and popup and retains dated out-of-period details", () => {
    const clock = createHistoryClock();
    render(<HistoricalHarness clock={clock} />);

    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Old Harbour" }));
    expect(screen.getByTestId("selected").textContent).toContain("harbour");
    expect(screen.getByTestId("hovered").textContent).toContain("harbour");
    expect(screen.getByTestId("popup").textContent).toContain("Old Harbour");

    // A supported rename keeps the same Map Feature selected (1.18).
    act(() => clock.seek(1860));
    expect(screen.getByTestId("selected").textContent).toContain("harbour");
    expect(screen.getByTestId("popup").textContent).toContain("New Harbour");

    act(() => clock.seek(1910));
    expect(screen.queryByTestId("popup")).toBeNull();
    expect(screen.getByTestId("selected").textContent).toContain("none");
    expect(screen.getByTestId("hovered").textContent).toContain("none");
    expect(screen.queryByRole("button", { name: "New Harbour" })).toBeNull();

    const panel = screen.getByRole("region", { name: "Historical context" });
    expect(panel.textContent).toContain("Out of period");
    expect(panel.textContent).toContain("New Harbour");
    expect(panel.textContent).toContain("Details refer to1860 (1800–1899)");
    expect(panel.textContent).toContain("Map date1910");
    expect(panel.textContent).toContain("Modern Harbourtown");
    expect(panel.textContent).toContain("Neuhafen");
    expect(panel.textContent).toContain("Consumer details for harbour");
  });

  test("returning into the period and out-of-order seeks never reselect without explicit navigation", () => {
    const clock = createHistoryClock();
    render(<HistoricalHarness clock={clock} />);

    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    act(() => {
      clock.seek(1905);
    });
    act(() => {
      clock.seek(1830);
    });
    act(() => {
      clock.seek(1915);
    });
    act(() => {
      clock.seek(1840);
    });

    expect(screen.getByTestId("selected").textContent).toContain("none");
    expect(screen.queryByTestId("popup")).toBeNull();
    const panel = screen.getByRole("region", { name: "Historical context" });
    expect(panel.textContent).toContain("Applies at the map date — not selected");
    // The details still refer to the date they were opened at.
    expect(panel.textContent).toContain("Details refer to1820");
    expect(panel.textContent).toContain("Map date1840");
  });

  test("the mini-timeline changes nothing until a supported date is activated, then reselects", () => {
    const clock = createHistoryClock();
    render(<HistoricalHarness clock={clock} />);

    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    act(() => clock.seek(1910));

    const timeline = screen.getByRole("navigation", { name: "Supported dates" });
    const unsupported = screen.getByRole("button", { name: "1950" });
    expect((unsupported as HTMLButtonElement).disabled).toBe(true);
    expect(timeline.textContent).toContain("Outside this map's timeline");

    // Focusing or trying an unavailable date leaves map time and selection unchanged.
    screen.getByRole("button", { name: "1860" }).focus();
    fireEvent.click(unsupported);
    expect(clock.getSnapshot().activeTime).toBe(1910);
    expect(screen.getByTestId("selected").textContent).toContain("none");

    clock.play();
    fireEvent.click(screen.getByRole("button", { name: "1860" }));
    expect(clock.getSnapshot()).toMatchObject({ activeTime: 1860, isPlaying: false });
    expect(screen.getByTestId("selected").textContent).toContain("harbour");
    expect(screen.getByTestId("popup").textContent).toContain("New Harbour");
    expect(screen.queryByRole("region", { name: "Historical context" })).toBeNull();
  });

  test("an application-controlled time reselects only once the map samples the navigated date", () => {
    const requests: number[] = [];
    const clock = createMapScopedTimelineClock({
      onTimeChange: (time) => requests.push(time),
      timeRange: { end: 1920, start: 1800 },
    });
    clock.setControlledTime(1820);
    render(<HistoricalHarness clock={clock} />);

    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    act(() => clock.setControlledTime(1910));
    fireEvent.click(screen.getByRole("button", { name: "1860" }));

    expect(requests).toContain(1860);
    expect(screen.getByTestId("selected").textContent).toContain("none");

    // A newer, different time from the application wins over the older navigation request.
    act(() => clock.setControlledTime(1912));
    act(() => clock.setControlledTime(1860));
    expect(screen.getByTestId("selected").textContent).toContain("none");
    expect(screen.getByRole("region", { name: "Historical context" })).toBeTruthy();
  });

  test("a new applicable selection replaces the context; dismissing closes it; stale picks are ignored", () => {
    const clock = createHistoryClock();
    render(<HistoricalHarness clock={clock} />);

    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    act(() => clock.seek(1905));
    expect(screen.getByRole("region", { name: "Historical context" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "mill" }));
    expect(screen.getByTestId("selected").textContent).toContain("mill");
    expect(screen.queryByRole("region", { name: "Historical context" })).toBeNull();

    act(() => clock.seek(1820));
    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    act(() => clock.seek(1905));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Historical context" })).toBeNull();
  });

  test("changing the viewer language relabels without changing the date or the selection", () => {
    const clock = createHistoryClock();
    const { rerender } = render(<HistoricalHarness clock={clock} />);

    fireEvent.click(screen.getByRole("button", { name: "Old Harbour" }));
    rerender(<HistoricalHarness clock={clock} locale="de" />);
    expect(screen.getByTestId("selected").textContent).toContain("harbour");
    expect(screen.getByTestId("popup").textContent).toContain("Althafen");

    rerender(<HistoricalHarness clock={clock} locale="es" />);
    expect(screen.getByTestId("popup").textContent).toContain("Portus Vetus");
    act(() => clock.seek(1905));
    expect(screen.getByRole("region", { name: "Historical context" }).textContent).toContain("No established form in this language; showing the attested original form.",
    );
    expect(clock.getSnapshot().activeTime).toBe(1905);
  });
});
