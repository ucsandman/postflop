# solver-web

Browser UI for the HU NLHE postflop solver. Next.js 16 (App Router), TypeScript,
Tailwind 4. No UI kit, no state library — plain React state and props.

```
wasm-pack build ../wasm --target web --out-dir pkg   # from the repo root: wasm-pack build wasm --target web --out-dir pkg
npm install
npm run dev
```

## How the wasm is wired

`scripts/sync-wasm.mjs` (npm `predev`/`prebuild`) copies `../wasm/pkg` into two
places:

| destination | contents | consumer |
| --- | --- | --- |
| `vendor/solver-wasm/` | `solver_wasm.js`, `.d.ts` | bundled by Next, typed |
| `public/wasm/` | `solver_wasm.js`, `solver_wasm_bg.wasm` | fetched over HTTP by `init()` and the worker |

It also copies the two fixture solutions into `public/fixtures/`.

Three deliberate choices:

1. **`ssr: false`.** `app/page.tsx` pulls in `components/Workbench` with
   `next/dynamic` and `ssr: false`. A `SolutionHandle` is a pointer into wasm
   linear memory; there is nothing for the server to render.
2. **Dynamic `import()` of the glue.** `lib/wasm.ts` imports the wasm-pack glue
   inside an async function, not at module scope, so it never enters a module
   graph the server evaluates. `loadWasm()` memoises the init promise and drops
   it on failure so a retry is possible.
3. **The binary is fetched from `/wasm/`, not emitted by the bundler.**
   `init({ module_or_path: "/wasm/solver_wasm_bg.wasm" })`. The sync script also
   rewrites the glue's `new URL('solver_wasm_bg.wasm', import.meta.url)` fallback
   to that same path — Turbopack tries to *resolve* that asset at build time even
   when it is never used, and the binary is not next to the vendored copy.

## Solving off the main thread

`solve_spot` has no yield point: it blocks its thread from the first iteration to
the last. On the main thread that would freeze the page and deliver every
progress callback in one paint after the solve had already finished. So solving
and `tree_stats` run in `public/solve-worker.js`, a module worker with its own
copy of the module. The finished solution crosses back as `to_json()` text and is
re-opened with `load_solution` on the main thread — the wasm API guarantees that
round trip is exact, and a handle cannot be shared across memories.

## Layout

```
app/            layout, globals.css (design tokens), page.tsx (dynamic import)
components/
  Workbench.tsx tab shell, handle ownership, node/tree state
  RangeGrid.tsx 169-cell grid, strategy bars or reach density
  ComboPanel.tsx per-combo distribution + EV for one cell
  TreeNav.tsx   breadcrumb, action buttons, 52-card runout selector
  SolvePanel.tsx solve form, preflight gate, progress curve
  Help.tsx      about / how to read the grid
  Card.tsx      card and combo rendering
lib/
  wasm.ts       async module loader
  types.ts      shapes of the JSON the wasm API returns
  grid.ts       grid aggregation, action colours, formatting
  config.ts     solve form <-> engine TOML
scripts/sync-wasm.mjs
docs/screens/   verification screenshots
```

## Conventions worth knowing

- Player 0 is OOP, player 1 is IP. Amounts are chips.
- `combos()` weights are reach on the range's own scale (no deal probabilities).
  Grid cells aggregate with those weights.
- A combo with zero compatible opponent mass has **no defined EV** and comes back
  `NaN`. It renders as `—`, never as `0.00`.
- A grid cell with live combos but zero total reach falls back to an unweighted
  mean over those combos and is rendered faded, because the weighted number would
  be 0/0. A cell with no live combos at all is dark and unclickable.
- Freeing a `SolutionHandle` happens outside React state updaters. Updaters must
  be pure — React replays them, and a second `free()` on the same pointer traps
  with "null pointer passed to rust".

## Checks

```
npm run build   # includes tsc
npm run lint
```
