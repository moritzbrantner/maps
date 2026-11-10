#!/usr/bin/env node
// Process target of `maps-atlas-tileset-v1`: one Chromium launch and one Atlas journey,
// so runtime-profiler's process collector samples the same work as its browser collector.

import { chromium } from "@playwright/test";
import { ATLAS_TILESET_VIEWPORT, run } from "./profile-atlas-tileset-journey.ts";

const browser = await chromium.launch({ timeout: 10_000 });
try {
  const page = await browser.newPage({ viewport: ATLAS_TILESET_VIEWPORT });
  const observation = await run({ page });
  process.stdout.write(
    `${JSON.stringify({
      scenarioId: observation.scenarioId,
      implementation: observation.implementation,
      firstUsefulMapMs: observation.firstUsefulMapMs,
      archiveRequests: observation.archiveRequests,
      archiveBytes: observation.archiveBytes,
    })}\n`,
  );
} finally {
  await browser.close();
}
