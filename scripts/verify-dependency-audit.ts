const existingHighAdvisories = [
  "GHSA-c83g-rgw3-j3cx",
  "GHSA-73wf-gq98-2v4g",
  "GHSA-mwp4-54f8-5fhr",
  "GHSA-mh99-v99m-4gvg",
  "GHSA-rgw5-rvv9-x895",
  "GHSA-3jxr-9vmj-r5cp",
  "GHSA-28wg-ghj8-5hjv",
  "GHSA-2v37-7h3g-55p8",
  "GHSA-r28c-9q8g-f849",
  "GHSA-4cwx-7wf7-3272",
  "GHSA-7p8r-x3mc-p8w7",
  "GHSA-v2hh-gcrm-f6hx",
  "GHSA-4c8g-83qw-93j6",
  "GHSA-52cp-r559-cp3m",
  "GHSA-5p4m-2wfm-xmqj",
] as const;

const auditArgs = ["bun", "audit", "--audit-level", "high"];
for (const advisory of existingHighAdvisories) {
  auditArgs.push("--ignore", advisory);
}

const audit = Bun.spawnSync(auditArgs, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

if (audit.exitCode !== 0) {
  process.exit(audit.exitCode);
}
