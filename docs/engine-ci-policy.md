# Engine CI policy

Engine work uses exact-head evidence. Required deterministic correctness checks must be green on the exact candidate. Canonical runtime evidence must be associated with immutable reference/candidate identities. Downstream consumers should reuse the exact validated build/evidence artifact where possible. A workflow that does not start, missing profiler capability, skipped required journey, or incomparable evidence is not interpreted as green.
