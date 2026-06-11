# Keep Editor Portable Until Split

The GeoJSON editor stays in this repository for now as a controlled, portable
map editing module. Consuming applications own persistence, save and cancel
flows, product-specific toolbar state, and domain rules; extraction to another
repository should be triggered by dependency shape, ownership, UI assumptions,
or release cadence rather than size alone.
