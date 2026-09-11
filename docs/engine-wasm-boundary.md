# WASM boundary

The WASM layer transports Maps-owned state and operations between browser host and Rust engine. Prefer persistent handles and packed data for large/repeated workloads after measurement justifies them. Avoid full-dataset retransfers per frame/query. The WASM layer does not independently normalize or reinterpret map semantics already owned by `maps-core`.
