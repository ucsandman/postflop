// Regression test for the zero-reach guard in buildGrid (web/lib/grid.ts).
// Pure TS, no framework: `node lib/grid.test.ts` from web/ (Node 22.6+ strips
// erasable TS syntax natively, no build step needed).
import assert from "node:assert/strict";
import { buildGrid } from "./grid.ts";
import type { Combo } from "./types.ts";

const combo = (index: number, cards: string, weight: number): Combo => ({ index, cards, weight });

// One decision node, three tiers of reach:
//   AA   ~2.0    real, dominant reach
//   72s  0.0002  real but small (1e-4 of the node max) -- must stay "has reach"
//   72o  2e-9    float noise from a chain of near-zero strategy probs on a dead
//                line (the engine backfills an exactly-uniform strategy for combos
//                it never actually reaches) -- above the OLD absolute 1e-12 cutoff,
//                but ~9 orders below this node's real reach -- must flip to noReach
const combos: Combo[] = [
  combo(0, "AsAh", 1.0),
  combo(1, "AdAc", 1.0),
  combo(2, "2s7s", 0.0002),
  combo(3, "2s7h", 1e-9),
  combo(4, "2d7c", 1e-9),
];
const numActions = 2;
// action-major: strategy[a * n + i], uniform (what the engine emits for dead combos)
const strategy = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);

const cells = buildGrid(combos, strategy, numActions);
const byLabel = (label: string) => {
  const c = cells.find((x) => x.label === label);
  if (!c) throw new Error(`no cell labelled ${label}`);
  return c;
};

assert.equal(byLabel("AA").noReach, false, "AA (weight 2.0, the node max) must not be flagged noReach");
assert.equal(
  byLabel("72s").noReach,
  false,
  "72s (weight 2e-4, real but small) must not be flagged noReach -- tiny-but-real reach is legitimate",
);
assert.equal(
  byLabel("72o").noReach,
  true,
  "72o (weight 2e-9, ~9 orders below the node max) is float noise on a dead line and must be flagged noReach",
);

console.log("PASS: grid.test.ts");
