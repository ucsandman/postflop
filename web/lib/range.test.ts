// Tests for the range-editor logic in web/lib/range.ts.
// Pure TS + the real wasm engine, no framework: `node lib/range.test.ts` from web/
// (Node 22.6+ strips erasable TS syntax natively, no build step needed).
//
// The load-bearing claim is the round trip: whatever the 13x13 grid is painted to,
// `canonicalRange` must produce a string the ENGINE's own parser expands back to the
// same 169 weights. So the parser here is the real `parse_range` out of the wasm
// module, not a JS re-implementation that could agree with a shared bug.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLASS_LABELS,
  HAND_ORDER,
  NUM_CLASSES,
  canonicalRange,
  classIndex,
  classMap,
  classWeights,
  comboCount,
  rangeSize,
  topWeights,
} from "./range.ts";
import { initSync, combo_labels, parse_range } from "../vendor/solver-wasm/solver_wasm.js";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
initSync({ module: readFileSync(join(web, "public", "wasm", "solver_wasm_bg.wasm")) });

const MAP = classMap(JSON.parse(combo_labels()) as string[]);

/** Grid weights -> string -> the engine -> grid weights. */
const roundTrip = (weights: number[]) => {
  const text = canonicalRange(weights);
  const parsed = JSON.parse(parse_range(text)) as { weights: number[] };
  return { text, back: classWeights(parsed.weights, MAP) };
};

const paint = (spec: Record<string, number>) => {
  const w = new Array<number>(NUM_CLASSES).fill(0);
  for (const [label, v] of Object.entries(spec)) w[classIndex(label)] = v;
  return w;
};

// --- the ordering the top-X% slider walks ---------------------------------
assert.equal(HAND_ORDER.length, NUM_CLASSES, "HAND_ORDER must list all 169 classes");
assert.equal(new Set(HAND_ORDER).size, NUM_CLASSES, "HAND_ORDER must not repeat a class");
for (const label of CLASS_LABELS) {
  assert.ok(HAND_ORDER.includes(label), `HAND_ORDER is missing ${label}`);
}
assert.equal(
  HAND_ORDER.reduce((n, l) => n + comboCount(classIndex(l)), 0),
  1326,
  "the 169 classes must account for exactly 1326 combos",
);
const rank = new Map(HAND_ORDER.map((l, i) => [l, i]));
const RANKS = "AKQJT98765432";
for (let r = 1; r < 13; r++) {
  const stronger = RANKS[r - 1] + RANKS[r - 1];
  const weaker = RANKS[r] + RANKS[r];
  assert.ok(rank.get(stronger)! < rank.get(weaker)!, `${stronger} must outrank ${weaker}`);
}
for (let hi = 0; hi < 13; hi++) {
  for (let lo = hi + 1; lo < 13; lo++) {
    const s = RANKS[hi] + RANKS[lo] + "s";
    const o = RANKS[hi] + RANKS[lo] + "o";
    assert.ok(rank.get(s)! < rank.get(o)!, `${s} must outrank ${o}`);
  }
}

// --- exact collapsing: the tokens the canonicaliser is allowed to emit -----
assert.equal(canonicalRange(paint({ AA: 1 })), "AA", "a lone class stays explicit");
assert.equal(
  canonicalRange(topWeights(100)),
  "22+,A2s+,K2s+,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,A2o+,K2o+,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o",
  "every class in the range collapses to one plus-token per chain",
);

const allPairs = paint(Object.fromEntries(RANKS.split("").map((r) => [r + r, 1])));
assert.equal(canonicalRange(allPairs), "22+", "a full pair chain is 22+");

assert.equal(
  canonicalRange(paint({ AKs: 1, AQs: 1, AJs: 1, ATs: 1 })),
  "ATs+",
  "a suited run touching the top of its chain is ATs+",
);
assert.equal(
  canonicalRange(paint({ A5s: 1, A4s: 1, A3s: 1, A2s: 1 })),
  "A5s-A2s",
  "a suited run away from the top of its chain is a dash range",
);
assert.equal(
  canonicalRange(paint({ "99": 1, "88": 1, "77": 1, "66": 1 })),
  "99-66",
  "a pair run away from AA is a dash range",
);
assert.equal(
  canonicalRange(paint({ AKs: 1, AQs: 1, AJs: 1, ATs: 1, A5s: 1, A4s: 1, A3s: 1, A2s: 1 })),
  "ATs+,A5s-A2s",
  "a chain with a gap emits one token per run",
);
assert.equal(
  canonicalRange(paint({ KQo: 1, KJo: 1, AA: 1, KK: 1 })),
  "KK+,KJo+",
  "pairs are emitted before the suited and offsuit chains",
);
assert.equal(
  canonicalRange(paint({ AKs: 1, AQs: 0.5, AJs: 0.5, ATs: 0.5 })),
  "AKs,AQs-ATs:0.5",
  "a run only collapses across an EQUAL weight; the partial run carries :weight",
);
assert.equal(
  canonicalRange(paint({ AA: 1, KK: 0.5, QQ: 0.5, JJ: 0.25 })),
  "AA,KK-QQ:0.5,JJ:0.25",
  "weights split a chain into runs and each run keeps its own suffix",
);
assert.equal(canonicalRange(paint({ AA: 0 })), "", "an empty grid is the empty string");

// --- round trip through the real engine parser ----------------------------
{
  // The exact collapsings above, re-expanded by the engine.
  for (const spec of [
    { AA: 1 },
    { AKs: 1, AQs: 1, AJs: 1, ATs: 1 },
    { A5s: 1, A4s: 1, A3s: 1, A2s: 1 },
    { "99": 1, "88": 1, "77": 1, "66": 1 },
    { AA: 1, KK: 0.5, QQ: 0.5, JJ: 0.25 },
    { AKs: 1, AQs: 0.5, AJs: 0.5, ATs: 0.5 },
    { "72o": 0.75, "32s": 1, KQo: 0.25 },
  ]) {
    const w = paint(spec);
    const { text, back } = roundTrip(w);
    for (let i = 0; i < NUM_CLASSES; i++) {
      assert.ok(
        Math.abs(back[i] - w[i]) < 1e-6,
        `${text}: ${CLASS_LABELS[i]} came back ${back[i]}, painted ${w[i]}`,
      );
    }
  }
}

{
  // Every top-X% cut, 0..100.
  for (let pct = 0; pct <= 100; pct++) {
    const w = topWeights(pct);
    const { text, back } = roundTrip(w);
    for (let i = 0; i < NUM_CLASSES; i++) {
      assert.ok(Math.abs(back[i] - w[i]) < 1e-6, `top ${pct}% (${text}): ${CLASS_LABELS[i]} diverged`);
    }
  }
}

{
  // Deterministic pseudo-random paints across the whole weight alphabet the brush emits.
  let seed = 20260901;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alphabet = [0, 0.25, 0.5, 0.75, 1, 0.1, 0.33, 0.6];
  for (let trial = 0; trial < 60; trial++) {
    const w = Array.from({ length: NUM_CLASSES }, () => alphabet[Math.floor(next() * alphabet.length)]);
    const { text, back } = roundTrip(w);
    for (let i = 0; i < NUM_CLASSES; i++) {
      assert.ok(
        Math.abs(back[i] - w[i]) < 1e-6,
        `trial ${trial} (${text}): ${CLASS_LABELS[i]} came back ${back[i]}, painted ${w[i]}`,
      );
    }
  }
}

// --- combo counting -------------------------------------------------------
assert.deepEqual(rangeSize(topWeights(100)), { combos: 1326, pct: 100 });
assert.deepEqual(rangeSize(paint({ AA: 1, AKs: 1, AKo: 1 })), { combos: 22, pct: (100 * 22) / 1326 });
assert.equal(rangeSize(paint({ AA: 0.5 })).combos, 3, "a half-weight pair is 3 combos");
{
  const top25 = topWeights(25);
  const { combos, pct } = rangeSize(top25);
  assert.equal(combos, 330);
  assert.ok(pct <= 25 && pct > 24, `top 25% should land just under the cut, got ${pct}`);
  // ...and the engine agrees on the count.
  const parsed = JSON.parse(parse_range(canonicalRange(top25))) as { nonzero: number };
  assert.equal(parsed.nonzero, 330, "engine must see the same 330 combos");
}

// --- explicit-combo text collapses to the class mean ----------------------
{
  // "AhKh" alone is 1 of AKs's 4 combos, so the grid can only show the mean, 0.25.
  const parsed = JSON.parse(parse_range("AhKh")) as { weights: number[] };
  const w = classWeights(parsed.weights, MAP);
  assert.ok(Math.abs(w[classIndex("AKs")] - 0.25) < 1e-6, `AKs mean should be 0.25, got ${w[classIndex("AKs")]}`);
  assert.equal(w[classIndex("AKo")], 0);
}

console.log(`PASS: range.test.ts (${NUM_CLASSES} classes, 101 top-X cuts + 67 paints round-tripped through parse_range)`);
