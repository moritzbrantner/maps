# Canvas2D boundary

Canvas2D is the deterministic reference pixel backend for the first-party engine. It should remain simple, readable and semantically downstream of Maps render preparation. Its role is correctness, compatibility evidence and fallback; performance optimizations must not cause it to invent a parallel feature/style/geometry model.
