// Tests for the trainer's grading math (web/lib/trainer.ts).
// Pure TS, no framework: `node lib/trainer.test.ts` from web/ (Node 22.6+ strips
// erasable TS syntax natively, no build step needed).
import assert from "node:assert/strict";
import {
  BEST_FREQ,
  flipHand,
  gradeable,
  grade,
  isClose,
  parseHand,
  loadHistory,
  pickUniform,
  pickWeighted,
  rollAction,
  rollD100,
  saveHistory,
  summarize,
  type HandRecord,
} from "./trainer.ts";

/** Deterministic stand-in for Math.random: hands back the given draws in order. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

// --- grade ---------------------------------------------------------------------------
// One node, pot 10, three actions. Hero's combo: check is best by a nose, bet is the
// mixed line, fold is the disaster.
const pot = 10;
const evs = [2.0, 1.96, -1.0]; // check / bet / fold
const freqs = [0.4, 0.6, 0.0];

{
  const g = grade(evs, freqs, 0, pot);
  assert.equal(g.bestAction, 0);
  assert.equal(g.evLoss, 0);
  assert.equal(g.tier, "best", "taking the max-EV action is always Best");
  assert.equal(g.freq, 0.4);
}

{
  // Mixed node: the 60%-frequency action is NOT the max-EV one. It still grades on EV
  // loss (0.04 chips = 0.4% pot), which lands inside Correct -- not on frequency match.
  const g = grade(evs, freqs, 1, pot);
  assert.equal(g.bestAction, 0);
  assert.ok(Math.abs(g.evLoss - 0.04) < 1e-9, `evLoss ${g.evLoss}`);
  assert.ok(Math.abs(g.pctPot - 0.004) < 1e-9, `pctPot ${g.pctPot}`);
  assert.equal(g.tier, "correct");
}

{
  // Same shape, but the solver plays it at BEST_FREQ or more: a primary line, so Best
  // outright even though another action edges it on EV.
  const g = grade(evs, [0.3, BEST_FREQ, 0.05], 1, pot);
  assert.equal(g.tier, "best", "a >=65% action is a primary solver line, not a mistake");
  assert.ok(g.evLoss > 0, "the EV loss is still reported honestly");
}

// Threshold walk, all at 0% frequency so only EV loss can decide the tier.
const tierAt = (loss: number) => grade([0, -loss], [0, 0], 1, pot).tier;
assert.equal(tierAt(0.049), "correct"); // 0.49% pot
assert.equal(tierAt(0.05), "inaccuracy"); // exactly 0.5% pot -- boundary belongs above
assert.equal(tierAt(0.199), "inaccuracy");
assert.equal(tierAt(0.2), "wrong"); // 2% pot
assert.equal(tierAt(0.499), "wrong");
assert.equal(tierAt(0.5), "blunder"); // 5% pot
assert.equal(tierAt(4), "blunder");

{
  // Folding the best hand in the spot: 3.0 chips of a 10-chip pot.
  const g = grade(evs, freqs, 2, pot);
  assert.equal(g.tier, "blunder");
  assert.ok(Math.abs(g.pctPot - 0.3) < 1e-9);
}

// A pot of 0 can't produce a percentage; the grade must not become NaN or Infinity.
assert.equal(grade([1, 0], [0, 1], 1, 0).pctPot, 0);

// --- gradeable -----------------------------------------------------------------------
assert.equal(gradeable([1, 2, 3]), true);
assert.equal(gradeable([1, NaN, 3]), false, "a NaN action EV makes the spot ungradeable");
assert.equal(gradeable([]), false);

// --- isClose -------------------------------------------------------------------------
// Top two within 1% of a 10-chip pot (0.1 chips).
assert.equal(isClose([2.0, 1.96, -1.0], pot), true);
assert.equal(isClose([2.0, 1.5, -1.0], pot), false, "0.5 chips is 5% of pot, not close");
assert.equal(isClose([2.0], pot), false, "one action is never a close decision");
assert.equal(isClose([2.0, 1.99], 0), false, "no pot, no percentage");
// Order-independent: the gap is between the top two, wherever they sit.
assert.equal(isClose([-1.0, 1.96, 2.0], pot), true);

// --- pickWeighted / pickUniform ------------------------------------------------------
// weights 1/3/0/6 => cut points at 0.1, 0.4, 0.4, 1.0 of the total.
const w = [1, 3, 0, 6];
assert.equal(pickWeighted(w, seq(0.0)), 0);
assert.equal(pickWeighted(w, seq(0.09)), 0);
assert.equal(pickWeighted(w, seq(0.11)), 1);
assert.equal(pickWeighted(w, seq(0.39)), 1);
assert.equal(pickWeighted(w, seq(0.41)), 3);
assert.equal(pickWeighted(w, seq(0.999999)), 3, "the top of the range never falls off the end");
assert.equal(pickWeighted([0, 0, 0], seq(0.5)), -1, "no positive weight, no pick");
assert.equal(pickWeighted([], seq(0.5)), -1);
assert.equal(pickWeighted(new Float32Array([0, 2]), seq(0.5)), 1, "typed arrays too");

assert.equal(pickUniform(4, seq(0.0)), 0);
assert.equal(pickUniform(4, seq(0.999999)), 3, "never one past the end");
assert.equal(pickUniform(0, seq(0.5)), -1);

// --- randomizer hint -----------------------------------------------------------------
assert.equal(rollD100(seq(0)), 1);
assert.equal(rollD100(seq(0.999)), 100);

// 30% check / 70% bet: rolls 1-30 check, 31-100 bet.
assert.equal(rollAction([0.3, 0.7], 1), 0);
assert.equal(rollAction([0.3, 0.7], 30), 0);
assert.equal(rollAction([0.3, 0.7], 31), 1);
assert.equal(rollAction([0.3, 0.7], 100), 1);
assert.equal(rollAction([0.3, 0.0, 0.7], 50), 2, "a 0%-frequency action is never rolled");
assert.equal(rollAction([0, 0], 50), -1);

// --- session stats -------------------------------------------------------------------
const rec = (tier: HandRecord["tier"], pctPot: number): HandRecord => ({
  node: 1,
  row: 0,
  col: 0,
  cards: "AsKd",
  board: "Qs Jh 2h",
  action: "check",
  tier,
  evLoss: pctPot * 10,
  pctPot,
  freq: 0.5,
});

assert.deepEqual(summarize([]), { hands: 0, correct: 0, accuracy: 0, avgLossPct: 0 });
{
  const s = summarize([rec("best", 0), rec("correct", 0.004), rec("blunder", 0.2)]);
  assert.equal(s.hands, 3);
  assert.equal(s.correct, 2, "best and correct both count as correct");
  assert.ok(Math.abs(s.accuracy - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.avgLossPct - 0.204 / 3) < 1e-9);
}

// --- persistence ---------------------------------------------------------------------
// Plain Node has no `localStorage`; the try/catch in save/loadHistory already has to
// survive that, so exercise both the working case and the missing-global case.
class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}
const storage = new FakeStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

assert.deepEqual(loadHistory(), [], "nothing stored yet");
saveHistory([rec("blunder", 0.2), rec("best", 0)]);
assert.equal(loadHistory().length, 2);
assert.equal(loadHistory()[0].tier, "blunder");

// A corrupted or older-build blob must be dropped, not crash the trainer.
storage.setItem("solver-web.trainHistory", '[{"node":1},{"nope":true}]');
assert.deepEqual(loadHistory(), [], "structurally bad rows are filtered out");
storage.setItem("solver-web.trainHistory", "not json");
assert.deepEqual(loadHistory(), []);

// `unit` says what evLoss is denominated in. A row from before tournaments existed has
// no unit and is a chip row by definition; a row claiming a unit nothing solves in is a
// corrupted blob, not a third convention to guess at.
{
  const chips = { ...rec("best", 0), unit: "chips" as const };
  const cste = { ...rec("wrong", 0.03), unit: "cste" as const };
  const { unit: _dropped, ...legacy } = chips;
  storage.setItem("solver-web.trainHistory", JSON.stringify([chips, cste, legacy]));
  assert.deepEqual(
    loadHistory().map((r) => r.unit),
    ["chips", "cste", undefined],
    "both units survive, and a row with no unit is kept as the chip row it is",
  );
  storage.setItem(
    "solver-web.trainHistory",
    JSON.stringify([{ ...chips, unit: "bb" }, { ...chips, unit: 7 }, cste]),
  );
  assert.deepEqual(loadHistory(), [cste], "a row claiming an unknown unit is dropped");
}

delete (globalThis as { localStorage?: unknown }).localStorage;
assert.doesNotThrow(() => loadHistory(), "no localStorage global must not escape loadHistory");
assert.doesNotThrow(() => saveHistory([rec("best", 0)]), "nor saveHistory");

// --- parseHand / flipHand ------------------------------------------------------------
assert.equal(parseHand("AhKd"), "AhKd");
assert.equal(parseHand("ah kd"), "AhKd", "case and a space normalize");
assert.equal(parseHand("KD,AH"), "KdAh", "comma separator, order preserved as typed");
assert.equal(parseHand("Th9h"), "Th9h");
assert.equal(parseHand("AhAh"), null, "the same card twice is not a hand");
assert.equal(parseHand("Ah"), null, "one card is not a hand");
assert.equal(parseHand("AhKx"), null, "bad suit");
assert.equal(parseHand("1hKd"), null, "bad rank");
assert.equal(parseHand(""), null);
assert.equal(flipHand("AhKd"), "KdAh");
assert.equal(flipHand(flipHand("AhKd")), "AhKd");

console.log("trainer.test.ts: ok");
