# Engine contract versioning

Internal engine contracts may evolve during Milestones A-C, but scenario identities used for hosted reference/runtime evidence must remain versioned and immutable in meaning. Breaking scenario semantics require a new `-vN` id. Public JavaScript package API stability remains governed by the existing API stability policy; internal Rust engine types are not automatically public package contracts.
