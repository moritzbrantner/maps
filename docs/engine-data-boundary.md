# Data ownership

Opaque application payloads remain application/TypeScript-owned unless a map computation explicitly needs a normalized field. Rust engine inputs should use stable ids, coordinates and typed map-domain attributes rather than serializing arbitrary application object graphs into WASM. Preserve source identity so render/pick results can map back without making Rust own unrelated application data.
