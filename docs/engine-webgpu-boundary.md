# WebGPU boundary

WebGPU consumes typed Maps render data and owns GPU resource management, batching, uploads, draw dispatch and GPU-side picking. It does not own geographic semantics, clustering, style policy or feature truth. Backend selection must be measured against canonical workloads; unsupported WebGPU or device loss falls back through an explicit renderer capability boundary.
