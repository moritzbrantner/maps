# reusable-workflows integration

Reusable workflows may produce and consume the exact immutable Maps build/profiler/reference artifacts across jobs. They own transport/reuse mechanics, not map semantics or evaluator policy. A downstream job must verify artifact identity/integrity and must not silently rebuild under the same evidence identity.
