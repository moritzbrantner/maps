// Source-tree stand-in for `@moritzbrantner/maps/wasm` (tests and the dev server, which
// configure an explicit module URL when they need the real runtime). Published builds keep
// the self-reference external, so consumers resolve the built package export instead.
export default async function initialize(): Promise<never> {
  throw new Error(
    "The Maps WASM package is not built into the source tree; configure its module URL.",
  );
}
