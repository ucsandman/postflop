// Async, one-shot loader for the solver's WebAssembly module.
//
// Why it looks like this:
//   * `wasm-pack --target web` emits an ES module whose default export is the
//     initializer. Evaluating it during SSR/prerender is pointless (there is no
//     `WebAssembly.instantiateStreaming` story worth having on the server), so the
//     glue is pulled in with a *dynamic* `import()` inside this function. Nothing
//     wasm-shaped is ever in a module-level import graph the server touches.
//   * The page that owns a handle is itself loaded via `next/dynamic` with
//     `ssr: false` (see app/page.tsx), so this only ever runs in the browser.
//   * The binary is fetched from `/wasm/solver_wasm_bg.wasm` (copied into `public/`
//     by scripts/sync-wasm.mjs) rather than left to the bundler's asset pipeline.
//     One less thing that can differ between webpack, Turbopack, and `next start`.
import type * as SolverWasm from "@/vendor/solver-wasm/solver_wasm";

export type Wasm = typeof SolverWasm;
export type SolutionHandle = SolverWasm.SolutionHandle;

export const WASM_BINARY_URL = "/wasm/solver_wasm_bg.wasm";

let pending: Promise<Wasm> | null = null;

export function loadWasm(): Promise<Wasm> {
  if (!pending) {
    pending = (async () => {
      const mod = await import("@/vendor/solver-wasm/solver_wasm.js");
      await mod.default({ module_or_path: WASM_BINARY_URL });
      return mod as unknown as Wasm;
    })().catch((err) => {
      pending = null; // let a later attempt retry rather than cache the failure
      throw err;
    });
  }
  return pending;
}
