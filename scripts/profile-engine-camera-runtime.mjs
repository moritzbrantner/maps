#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { run } from "./profile-engine-camera-journey.ts";

const browser = await chromium.launch({ timeout: 10_000 });
try {
  const page = await browser.newPage();
  process.stdout.write(`${JSON.stringify(await run({ page }))}\n`);
} finally {
  await browser.close();
}
