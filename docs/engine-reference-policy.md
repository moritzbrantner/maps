# Reference implementation policy

Leaflet and MapLibre are compatibility oracles only where Maps intentionally adopts equivalent behavior. A reference result is normalized into a Maps-owned observation contract before comparison. Internal reference identifiers, incidental ordering, cache structure, private renderer behavior and undocumented quirks are not adopted automatically. When Maps intentionally differs, the scenario contract documents the difference and tests Maps' chosen semantics directly.
