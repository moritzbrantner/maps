# Engine tooling roles

The engine program uses existing repositories instead of duplicating their responsibilities.

| Tool | Role for Maps |
| --- | --- |
| coding-tooling | discover/invoke deterministic checks and canonical scenario capabilities |
| runtime-profiler | capture/normalize/validate immutable runtime evidence |
| Moonlight | compare reference/candidate behavior and apply evaluation policy |
| reusable-workflows | execute and reuse exact build/evidence artifacts across CI jobs |
| runtime-profiler Pages / repository dashboards | historical runtime evidence visualization |
| coding-tooling Pages | analyzer/discovery view of repository capabilities and strongest findings |

Maps owns the scenario fixtures and map-domain normalizers. It must not embed the internal schemas or policy of these tools as its public API.
