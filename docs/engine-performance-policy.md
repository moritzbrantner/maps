# Engine performance policy

Architectural performance decisions are based on representative canonical scenarios, not isolated best-case microbenchmarks. Keep microbenchmarks when they protect a deterministic kernel property, but do not use them alone to justify subsystem authority. Compare initialization and steady-state costs separately and preserve signed regressions/improvements rather than refreshing baselines to hide change.
