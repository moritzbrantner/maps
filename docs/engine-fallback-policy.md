# Engine fallback policy

Fallbacks are explicit capability boundaries, not silent semantic switching. Supported examples include server/no-WASM initialization, no-WebGPU, WebGPU device loss and temporary MapLibre reference/fallback paths during migration. Once a first-party runtime is selected as semantic authority for a supported capability, internal errors fail closed instead of silently selecting a different semantic implementation mid-session.
