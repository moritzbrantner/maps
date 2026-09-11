# Artifact reuse

When a build, runtime evidence bundle or normalized reference observation is validated for an immutable candidate identity, downstream jobs should consume that exact artifact rather than rebuild/recompute it unless the downstream operation itself is the subject being measured. Reuse must verify identity/integrity and fail closed on mismatch.
