# Engine scope

The first-party engine is a map engine, not a generic visualization framework. Its abstractions may be broad across map capabilities but should remain map-domain-specific: geographic camera/projection, tile/source lifecycle, map features/layers/styles, map-native render preparation and map interaction/picking. General-purpose scene-graph concerns belong elsewhere unless proven necessary for Maps itself.
