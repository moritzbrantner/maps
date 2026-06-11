# Keep Core Entrypoint Server Safe

The `@moritzbrantner/maps/core` entrypoint remains data-only and server-safe. It
must stay free of React, DOM, MapLibre, Three, `@moritzbrantner/ui`, and timeline
editor runtime imports so applications can use transforms, validation,
aggregation, measurement, heat-field, and temporal helpers outside the browser.
