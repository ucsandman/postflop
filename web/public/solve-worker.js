// Module worker that owns a second copy of the wasm module.
//
// `solve_spot` blocks its thread from the first iteration to the last — the engine
// has no yield point — so running it on the main thread would freeze the page and
// batch every progress callback into one paint after the solve already finished.
// Here the callbacks are posted out as they happen and the UI curve is genuinely live.
//
// The finished solution crosses back as `to_json()` text and is re-opened on the main
// thread with `load_solution`, which the wasm API guarantees is an exact round-trip.
// A SolutionHandle is a pointer into this worker's linear memory; it cannot be shared.
import init, { solve_spot, tree_stats } from "/wasm/solver_wasm.js";

let ready = null;
const boot = () => (ready ??= init({ module_or_path: "/wasm/solver_wasm_bg.wasm" }));

const message = (err) => (err && err.message ? err.message : String(err));

self.onmessage = async (event) => {
  const { id, kind, toml, maxIterations, targetPct, reportEvery } = event.data;
  try {
    await boot();
    if (kind === "stats") {
      self.postMessage({ id, kind: "stats", stats: tree_stats(toml) });
      return;
    }
    const started = performance.now();
    const handle = solve_spot(toml, maxIterations, targetPct, reportEvery, (iter, chips, pct) => {
      self.postMessage({ id, kind: "progress", iter, chips, pct });
    });
    const json = handle.to_json();
    handle.free();
    self.postMessage({ id, kind: "done", json, wall: (performance.now() - started) / 1000 });
  } catch (err) {
    self.postMessage({ id, kind: "error", message: message(err) });
  }
};
