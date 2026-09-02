// Regression test for the zero-reach guard in buildGrid (web/lib/grid.ts).
// Pure TS, no framework: `node lib/grid.test.ts` from web/ (Node 22.6+ strips
// erasable TS syntax natively, no build step needed).
import assert from "node:assert/strict";
import {
  ACTION_INKS,
  blockerScores,
  buildEvGrid,
  buildGrid,
  buildRunoutHotness,
  comboRegret,
  evColor,
  fadeToPlate,
  hotnessColor,
  RAMP_HI,
  RAMP_LO,
  regretColor,
} from "./grid.ts";
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

// --- buildEvGrid / evColor / regretColor -------------------------------------------
// One decision node, two combos, two actions (check/bet). AA clearly prefers bet
// (+4 vs -1); 72o is a near coin-flip (+0.1 vs 0.0) so it should read near-white in
// "ev" mode and carry real regret under a strategy that mixes away from the best action.
{
  const combos2: Combo[] = [combo(0, "AsAh", 2.0), combo(1, "7c2d", 1.0)];
  const numActions = 2;
  // action-major strategy[a*n+i]: AA always bets, 72o checks 50/50.
  const strategy = new Float32Array([0 /*check,AA*/, 0.5 /*check,72o*/, 1 /*bet,AA*/, 0.5 /*bet,72o*/]);
  const checkEvs = new Float32Array([-1, 0.1]);
  const betEvs = new Float32Array([4, 0.0]);

  const cells2 = buildGrid(combos2, strategy, numActions);
  // reach x compatible mass, as `combo_ev_weights` returns it; one combo per cell here,
  // so the weights only have to be nonzero for the cell to average to that combo's EV.
  const evWeights = new Float32Array([2.0 * 0.4, 1.0 * 0.9]);
  const evCells = buildEvGrid(cells2, evWeights, strategy, [checkEvs, betEvs], numActions);
  const aa = evCells.find((_, i) => cells2[i].label === "AA")!;
  const off = evCells.find((_, i) => cells2[i].label === "72o")!;

  assert.equal(aa.bestAction, 1, "AA: bet (+4) beats check (-1)");
  assert.ok(Math.abs(aa.margin - 5) < 1e-6, `AA margin should be 5, got ${aa.margin}`);
  // AA always bets (freq 1 on bet), so its actual EV equals the best EV: zero regret.
  assert.ok(Math.abs(aa.regret - 0) < 1e-6, `AA should have ~zero regret, got ${aa.regret}`);

  assert.equal(off.bestAction, 0, "72o: check (+0.1) beats bet (0.0)");
  assert.ok(Math.abs(off.margin - 0.1) < 1e-6, `72o margin should be 0.1, got ${off.margin}`);
  // 72o mixes 50/50 between the two actions: actual = 0.05, best = 0.1, regret = 0.05.
  assert.ok(Math.abs(off.regret - 0.05) < 1e-6, `72o regret should be 0.05, got ${off.regret}`);

  // evColor: a decisive cell (margin == the grid's max margin) is at the ramp ceiling;
  // a near-indifferent one (tiny margin relative to the grid) sinks toward the plate.
  const maxMargin = Math.max(aa.margin, off.margin);
  const aaColor = evColor(aa, ["#111111", "#e8202f"], maxMargin);
  const offColor = evColor(off, ["#111111", "#e8202f"], maxMargin);
  assert.equal(aaColor, fadeToPlate("#e8202f", RAMP_HI), "AA is the grid's most decisive cell: the ramp ceiling");
  assert.notEqual(offColor, aaColor, "72o is far less decisive: must not render at full strength");
  assert.notEqual(offColor, fadeToPlate("#e8202f", RAMP_LO), "72o still has a real (if small) margin: off the ramp floor");

  const empty = evColor({ actionEvs: [NaN, NaN], bestAction: -1, margin: NaN, regret: NaN }, ["#111"], 1);
  assert.equal(empty, null, "no EV data anywhere in the cell -> nothing to paint");

  // regretColor: 0 regret -> the ramp floor, NaN -> nothing to paint, larger regret ->
  // further up the heart-lit ramp than a smaller one.
  const maxRegret = Math.max(aa.regret, off.regret);
  assert.equal(regretColor(aa.regret, maxRegret), fadeToPlate("#ff4d5a", RAMP_LO), "zero regret must render the bare plate end of the ramp");
  assert.equal(regretColor(NaN, maxRegret), null, "undefined regret has nothing to paint");
  const g1 = regretColor(off.regret, maxRegret);
  assert.notEqual(g1, fadeToPlate("#ff4d5a", RAMP_LO), "72o has nonzero regret: must be off the ramp floor");
}

// Two combos in the SAME cell, equal reach but different compatible opponent mass (the
// normal case on a wet board): the cell must report the mass-weighted mean, not the
// reach-only one. 11/6 vs 1.5 is exactly the error `combos[i].weight` used to make.
{
  const same: Combo[] = [combo(0, "AsKs", 1.0), combo(1, "AhKh", 1.0)];
  const strategy = new Float32Array([1, 1]); // one action, always taken
  const evWeights = new Float32Array([5, 1]); // reach x compatible mass
  const evs = new Float32Array([2, 1]);

  const cells3 = buildGrid(same, strategy, 1);
  const evCells = buildEvGrid(cells3, evWeights, strategy, [evs], 1);
  const aks = evCells.find((_, i) => cells3[i].label === "AKs")!;
  assert.ok(
    Math.abs(aks.actionEvs[0] - 11 / 6) < 1e-6,
    `AKs must average by combo_ev_weights (11/6), got ${aks.actionEvs[0]}`,
  );
}

// --- blockerScores ------------------------------------------------------------------
// Opponent's next-decision combos: AsKd and AsQc both hold the As that the hero's AsKh
// blocks; 7h2c conflicts with neither hero card.
{
  const oppCombos: Combo[] = [combo(0, "AsKd", 1), combo(1, "AsQc", 1), combo(2, "7h2c", 1)];
  const numActions = 2; // fold, bet
  // action-major strategy[a*n+i]
  const oppStrategy = new Float32Array([
    0.2, 0.9, 0.5, // fold: AsKd, AsQc, 7h2c
    0.8, 0.1, 0.5, // bet:  AsKd, AsQc, 7h2c
  ]);

  const blocked = blockerScores(oppCombos, oppStrategy, numActions, "AsKh");
  assert.ok(
    Math.abs(blocked.unconditional[0] - 1.6 / 3) < 1e-6,
    `unconditional fold should be 1.6/3, got ${blocked.unconditional[0]}`,
  );
  // Only 7h2c survives the As/Kh conflict filter, so conditional == that combo's own strategy.
  assert.ok(Math.abs(blocked.conditional[0] - 0.5) < 1e-6, "conditional fold should be 7h2c's 0.5");
  assert.ok(Math.abs(blocked.conditional[1] - 0.5) < 1e-6, "conditional bet should be 7h2c's 0.5");
  assert.ok(
    Math.abs(blocked.delta[0] - (0.5 - 1.6 / 3)) < 1e-6,
    `fold delta should be conditional - unconditional, got ${blocked.delta[0]}`,
  );
  assert.ok(blocked.delta[1] > 0, "bet delta should be positive: removing the mostly-folding As combos raises bet frequency");

  // A hero hand that conflicts with none of the opponent's combos changes nothing.
  const unblocked = blockerScores(oppCombos, oppStrategy, numActions, "2h3d");
  assert.ok(Math.abs(unblocked.delta[0]) < 1e-9, "no-conflict hand: fold delta must be ~0");
  assert.ok(Math.abs(unblocked.delta[1]) < 1e-9, "no-conflict hand: bet delta must be ~0");

  // A hero hand that conflicts with every opponent combo leaves nothing in the
  // conditional set -- conditional defaults to 0, not NaN. "As7h": As hits AsKd/AsQc,
  // 7h hits 7h2c.
  const allBlocked = blockerScores(oppCombos, oppStrategy, numActions, "As7h");
  assert.deepEqual(allBlocked.conditional, [0, 0], "fully blocked opponent range: conditional is [0,0]");
}

// --- buildRunoutHotness / hotnessColor -----------------------------------------------
// Four runouts. Each child gets its own combo list -- child C loses 72o entirely (as a
// dealt card would, by removal), and child D's only combo has no defined EV.
{
  const aa = combo(0, "AsAh", 1);
  const off = combo(1, "7c2d", 1);

  const children = [
    { id: 10, combos: [aa, off], evWeights: new Float32Array([1, 1]), evs: new Float32Array([4, 0]) }, // mean 2
    { id: 11, combos: [aa, off], evWeights: new Float32Array([1, 1]), evs: new Float32Array([0, 0]) }, // mean 0
    { id: 12, combos: [aa], evWeights: new Float32Array([1]), evs: new Float32Array([1]) }, // mean 1
    { id: 13, combos: [aa], evWeights: new Float32Array([1]), evs: new Float32Array([NaN]) }, // no defined EV
  ];

  const range = buildRunoutHotness(children, null);
  // across-runouts mean of the three defined children (2, 0, 1) is 1.
  assert.ok(Math.abs(range.evByChild.get(10)! - 2) < 1e-6, "child 10 range EV should be 2");
  assert.ok(Math.abs(range.evByChild.get(11)! - 0) < 1e-6, "child 11 range EV should be 0");
  assert.ok(Math.abs(range.evByChild.get(12)! - 1) < 1e-6, "child 12 range EV should be 1");
  assert.ok(Number.isNaN(range.evByChild.get(13)), "child 13 has no defined EV: NaN");
  assert.ok(Math.abs(range.deviationByChild.get(10)! - 1) < 1e-6, "child 10 deviation should be +1");
  assert.ok(Math.abs(range.deviationByChild.get(11)! - -1) < 1e-6, "child 11 deviation should be -1");
  assert.ok(Math.abs(range.deviationByChild.get(12)! - 0) < 1e-6, "child 12 deviation should be 0");
  assert.ok(Number.isNaN(range.deviationByChild.get(13)), "child 13 deviation stays NaN");
  assert.ok(Math.abs(range.maxDeviation - 1) < 1e-6, `maxDeviation should be 1, got ${range.maxDeviation}`);

  // Selecting the AA cell narrows every child down to just its AA slot -- child 10's
  // single-hand EV (4) differs from its whole-range EV (2) computed above.
  const aaOnly = buildRunoutHotness(children, { row: 0, col: 0 });
  assert.ok(Math.abs(aaOnly.evByChild.get(10)! - 4) < 1e-6, "AA-only child 10 EV should be 4");
  assert.ok(Math.abs(aaOnly.evByChild.get(11)! - 0) < 1e-6, "AA-only child 11 EV should be 0");
  assert.ok(Math.abs(aaOnly.evByChild.get(12)! - 1) < 1e-6, "AA-only child 12 EV is unchanged (only combo was AA)");
  assert.ok(Number.isNaN(aaOnly.evByChild.get(13)), "AA-only child 13 still has no defined EV");

  // hotnessColor: positive deviation -> green, negative -> red, zero -> the bare plate,
  // NaN -> null.
  assert.equal(hotnessColor(1, 1), fadeToPlate("#007a45", RAMP_HI), "max positive deviation renders the green ceiling");
  assert.equal(hotnessColor(-1, 1), fadeToPlate("#b2101f", RAMP_HI), "max negative deviation renders the red ceiling");
  assert.equal(hotnessColor(0, 1), fadeToPlate("#007a45", RAMP_LO), "zero deviation renders the bare plate end");
  assert.equal(hotnessColor(NaN, 1), null, "undefined deviation has nothing to paint");
  assert.equal(hotnessColor(0.5, 0), fadeToPlate("#007a45", RAMP_LO), "maxDeviation of 0 (a flat grid) never saturates");
}

// fadeToPlate: t=1 is the untouched ink, t=0 is the bare raised plate, and it clamps
// out-of-range t. Nothing in this identity fades toward a light stock.
assert.equal(fadeToPlate("#e8202f", 1), "#e8202f");
assert.equal(fadeToPlate("#e8202f", 0), "#1e221c");
assert.equal(fadeToPlate("#e8202f", 1.5), fadeToPlate("#e8202f", 1), "t is clamped above 1");
assert.equal(fadeToPlate("#e8202f", -1), fadeToPlate("#e8202f", 0), "t is clamped below 0");

// The ramp ceiling is the contrast promise: the stock-white cell label (#F0F3F0) must
// clear 4.5:1 on every ink at full strength, or the grid modes are unreadable.
{
  const lum = (hex: string) => {
    const v = parseInt(hex.slice(1), 16);
    const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((n) => {
      const c = n / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const label = lum("#f0f3f0");
  for (const [ink, meaning] of ACTION_INKS.concat([["#ff4d5a", "regret"], ["#5b8cff", "reach"]])) {
    const bg = lum(fadeToPlate(ink, RAMP_HI));
    const ratio = (label + 0.05) / (bg + 0.05);
    assert.ok(ratio >= 4.5, `${meaning} (${ink}) at the ramp ceiling is ${ratio.toFixed(2)}:1, under 4.5`);
  }
}

// --- comboRegret ---------------------------------------------------------------------
{
  const strat = new Float32Array([0.5, 0.5]); // 1 combo, 2 actions
  const aEvs = [new Float32Array([2]), new Float32Array([0])];
  assert.equal(comboRegret(aEvs, strat, 2, 1, 0), 1, "mixing 50/50 between EV 2 and EV 0 leaves 1 chip");
  assert.ok(
    Number.isNaN(comboRegret([new Float32Array([NaN]), new Float32Array([0])], strat, 2, 1, 0)),
    "an undefined action EV makes the combo's regret undefined, not zero",
  );
}

console.log("PASS: grid.test.ts");
