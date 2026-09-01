# @moritzbrantner/ui conventions

## MORITZUI-001 — Compose applications from public component tiers

- Select public exports by semantic responsibility: stable primitives, patterns compositions, data collections, and shell chrome.
- Keep routing, server state, authorization, copy, and side effects in the app; use labs only with explicit upgrade ownership.

## MORITZUI-002 — Select one concrete theme contract

- Import exactly one concrete theme stylesheet per application surface.
- Import component-sources.css when rendering package components; use scoped themes only for intentional coexistence.

## Component selection

- Use ViewHeader for page identity/actions, DescriptionList for facts, ResourceList or ItemGroup for collections, DataGrid for comparison, and StateView for loading, empty, error, or offline states.
- Use Card only for a genuinely independent bounded object; otherwise prefer spacing, headings, separators, or a shared surface.
