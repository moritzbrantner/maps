# Worker boundary

Workers may host long-lived WASM engine state and expensive dataset/tile preparation to protect browser responsiveness. Worker placement is a runtime/lifecycle decision; it does not change semantic ownership. Prefer persistent handles and transferable/packed data where measurement proves bridge cost material.
