"use client";

import type { FlatLayer } from "./maplibre-compat";

export type FlatLayerEntry<TLayer = FlatLayer> = {
  layers: readonly TLayer[];
  signature: string;
};

export type FlatLayerPlan<TEntry extends FlatLayerEntry<unknown>> = {
  key: string;
  render: () => TEntry | null;
  signature: string;
  update?: (entry: TEntry) => boolean;
  updateOnSignatureChange?: boolean;
};

export type FlatLayerParent<TEntry extends FlatLayerEntry<unknown>> = {
  removeLayer: (layer: TEntry["layers"][number]) => unknown;
};

export function reconcileFlatLayerEntries<TEntry extends FlatLayerEntry<unknown>>({
  cache,
  layer,
  plans,
  remove = removeFlatLayerEntry,
}: {
  cache: Map<string, TEntry>;
  layer: FlatLayerParent<TEntry>;
  plans: Iterable<FlatLayerPlan<TEntry>>;
  remove?: (layer: FlatLayerParent<TEntry>, entry: TEntry) => void;
}) {
  const latestPlans = new Map<string, FlatLayerPlan<TEntry>>();

  for (const plan of plans) {
    // Last plan wins for duplicate keys, so any cached entry is replaced deterministically.
    if (latestPlans.has(plan.key)) {
      const cached = cache.get(plan.key);

      if (cached) {
        remove(layer, cached);
        cache.delete(plan.key);
      }
    }

    latestPlans.set(plan.key, plan);
  }

  for (const [key, plan] of latestPlans) {
    const cached = cache.get(key);

    if (cached?.signature === plan.signature) {
      if (!plan.update || plan.update(cached)) {
        continue;
      }

      remove(layer, cached);
      cache.delete(key);
    } else if (cached && plan.updateOnSignatureChange && plan.update?.(cached)) {
      cached.signature = plan.signature;
      continue;
    } else if (cached) {
      remove(layer, cached);
      cache.delete(key);
    }

    const rendered = plan.render();

    if (rendered) {
      cache.set(key, rendered);
    }
  }

  for (const [key, cached] of cache) {
    if (latestPlans.has(key)) {
      continue;
    }

    remove(layer, cached);
    cache.delete(key);
  }
}

export function removeFlatLayerEntry<TEntry extends FlatLayerEntry<unknown>>(
  layer: FlatLayerParent<TEntry>,
  entry: TEntry,
) {
  for (const cachedLayer of entry.layers) {
    layer.removeLayer(cachedLayer);
  }
}

export function clearFlatLayerEntries<TEntry extends FlatLayerEntry<unknown>>({
  cache,
  layer,
  remove = removeFlatLayerEntry,
}: {
  cache: Map<string, TEntry>;
  layer: FlatLayerParent<TEntry>;
  remove?: (layer: FlatLayerParent<TEntry>, entry: TEntry) => void;
}) {
  for (const cached of cache.values()) {
    remove(layer, cached);
  }

  cache.clear();
}

export type FlatLayerResourceState<TResource, TMetadata = unknown> = {
  metadata: TMetadata | null;
  requestId: number;
  resource: TResource | null;
  signature: string | null;
};

export function createFlatLayerResourceState<TResource, TMetadata = unknown>(): FlatLayerResourceState<
  TResource,
  TMetadata
> {
  return {
    metadata: null,
    requestId: 0,
    resource: null,
    signature: null,
  };
}

export function resetFlatLayerResourceState<TResource, TMetadata>({
  remove,
  revokeMetadata,
  state,
}: {
  remove: (resource: TResource) => void;
  revokeMetadata?: (metadata: TMetadata) => void;
  state: FlatLayerResourceState<TResource, TMetadata>;
}) {
  // Resetting also invalidates async completions that captured an older request id.
  state.requestId += 1;

  if (state.resource) {
    remove(state.resource);
  }

  if (state.metadata && revokeMetadata) {
    revokeMetadata(state.metadata);
  }

  state.metadata = null;
  state.resource = null;
  state.signature = null;
}

export function beginFlatLayerResourceRequest<TResource, TMetadata>(
  state: FlatLayerResourceState<TResource, TMetadata>,
) {
  state.requestId += 1;
  return state.requestId;
}

export function isCurrentFlatLayerResourceRequest<TResource, TMetadata>(
  state: FlatLayerResourceState<TResource, TMetadata>,
  requestId: number,
) {
  return state.requestId === requestId;
}
