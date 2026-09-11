# MapLibre migration policy

MapLibre remains valuable as a compatibility oracle and temporary fallback while responsibilities move. New first-party engine contracts must not require a live MapLibre instance unless they are explicitly reference adapters. Milestone B's exit requires a real MapLibre-free runtime path; Milestones D/E then reduce MapLibre from vector/cartography reference to optional compatibility dependency before removal is considered.
