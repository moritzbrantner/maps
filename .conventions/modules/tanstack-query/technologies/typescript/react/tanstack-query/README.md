# TanStack Query conventions

## QUERY-001 — TanStack Query is the owner of backend-derived data

- Read and cache backend data through TanStack Query; create local state only for distinct semantics such as drafts.

## QUERY-002 — Use structured deterministic query keys

- Use consistent hierarchical query keys and include every result-changing input.

## QUERY-003 — Update or invalidate the narrowest relevant query scope

- After mutations, update or invalidate only data that may have changed.

## QUERY-004 — Do not copy query results into local state

- Consume or derive query data directly; do not synchronize it into another owner.
