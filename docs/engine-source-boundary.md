# Source/tile boundary

Sources provide bytes/features through Maps-owned lifecycle contracts. The engine owns canonical tile identity, visibility, priority, cancellation, deduplication and cache semantics. Source adapters own acquisition/decoding details appropriate to the source type but do not choose camera state or duplicate cache truth.
