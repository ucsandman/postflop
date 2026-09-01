// Trainer grading: how much a chosen action costs against the solved strategy.
//
// Everything here is pure arithmetic plus an injected `rng`, so the grading path can be
// tested without a wasm handle and without touching `Math.random` (see trainer.test.ts).
// The tree-walking half of the trainer lives in components/TrainPanel.tsx, because it
// needs the handle.

/** Solver frequency at or above which the chosen action counts as "best" outright, even
 *  when a different action edges it on EV — at this frequency the solver plays it as a
 *  primary line and the EV gap is mixing noise, not a mistake. */
export const BEST_FREQ = 0.65;
/** EV loss thresholds, as a fraction of the pot at the node. */
export const CORRECT_PCT_POT = 0.005;
export const INACCURACY_PCT_POT = 0.02;
export const WRONG_PCT_POT = 0.05;
/** "Close decision": the top two actions are within this fraction of the pot for the
 *  dealt combo — the spots where the answer is actually worth training. */
export const CLOSE_PCT_POT = 0.01;

export type Tier = "best" | "correct" | "inaccuracy" | "wrong" | "blunder";

export const TIERS: Tier[] = ["best", "correct", "inaccuracy", "wrong", "blunder"];

export const TIER_LABEL: Record<Tier, string> = {
  best: "Best",
  correct: "Correct",
  inaccuracy: "Inaccuracy",
  wrong: "Wrong",
  blunder: "Blunder",
};

export type Rng = () => number;

export interface Grade {
  tier: Tier;
  /** Chips left on the table: best action's EV minus the chosen action's, never < 0. */
  evLoss: number;
  /** `evLoss` as a fraction of the pot at the node. */
  pctPot: number;
  /** Solver frequency of the chosen action for this exact combo. */
  freq: number;
  /** Index of the highest-EV action. */
  bestAction: number;
}

/**
 * Parse a hand the user typed — "AhKd", "ah kd", "KD AH" — into the engine's combo
 * spelling (rank uppercase, suit lowercase, in the order typed), or `null` when it
 * isn't two distinct cards. Matching against a combo list should try both card orders;
 * the solution spells each combo in its own canonical order.
 */
export function parseHand(text: string): string | null {
  const m = text
    .trim()
    .match(/^([2-9tjqka])([cdhs])[\s,]*([2-9tjqka])([cdhs])$/i);
  if (!m) return null;
  const a = m[1].toUpperCase() + m[2].toLowerCase();
  const b = m[3].toUpperCase() + m[4].toLowerCase();
  return a === b ? null : a + b;
}

/** The same two cards in the other order, for matching a combo list. */
export function flipHand(hand: string): string {
  return hand.slice(2) + hand.slice(0, 2);
}

/**
 * True when every action at the node has a defined EV for this combo. `combo_evs` is
 * `NaN` where the opponent's range cannot reach the child holding anything this hand
 * does not block, and a spot with such a hole cannot be graded — the dealer skips it.
 */
export function gradeable(actionEvs: number[]): boolean {
  return actionEvs.length > 0 && actionEvs.every((v) => !Number.isNaN(v));
}

/**
 * Grade one decision. `actionEvs`/`freqs` are indexed by action, both read for the single
 * combo the user was dealt; `actionEvs` must satisfy `gradeable`.
 *
 * Mixed nodes are graded on EV loss, not on matching the most-frequent action: when the
 * solver splits 55/45 between two actions that are worth the same, either one costs
 * nothing and both are correct.
 */
export function grade(actionEvs: number[], freqs: number[], chosen: number, pot: number): Grade {
  let bestAction = 0;
  for (let a = 1; a < actionEvs.length; a++) {
    if (actionEvs[a] > actionEvs[bestAction]) bestAction = a;
  }
  const evLoss = Math.max(0, actionEvs[bestAction] - actionEvs[chosen]);
  const pctPot = pot > 0 ? evLoss / pot : 0;
  const freq = freqs[chosen] ?? 0;
  const tier: Tier =
    chosen === bestAction || freq >= BEST_FREQ
      ? "best"
      : pctPot < CORRECT_PCT_POT
        ? "correct"
        : pctPot < INACCURACY_PCT_POT
          ? "inaccuracy"
          : pctPot < WRONG_PCT_POT
            ? "wrong"
            : "blunder";
  return { tier, evLoss, pctPot, freq, bestAction };
}

/** Whether the top two action EVs are within `CLOSE_PCT_POT` of the pot for this combo. */
export function isClose(actionEvs: number[], pot: number): boolean {
  if (actionEvs.length < 2 || pot <= 0) return false;
  const sorted = [...actionEvs].sort((x, y) => y - x);
  return sorted[0] - sorted[1] < CLOSE_PCT_POT * pot;
}

/** Index sampled proportionally to `weights`; -1 when nothing has positive weight. */
export function pickWeighted(weights: ArrayLike<number>, rng: Rng): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) total += weights[i];
  if (!(total > 0)) return -1;
  let r = rng() * total;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    last = i;
    r -= weights[i];
    if (r < 0) return i;
  }
  return last; // float slop at the very top of the range
}

/** Uniform index in `[0, length)`; -1 for an empty list. */
export function pickUniform(length: number, rng: Rng): number {
  return length > 0 ? Math.min(length - 1, Math.floor(rng() * length)) : -1;
}

/** A live-play randomizer roll, 1..100. */
export function rollD100(rng: Rng): number {
  return Math.floor(rng() * 100) + 1;
}

/** Which action a d100 roll selects under `freqs`, cumulative in action order. */
export function rollAction(freqs: number[], roll: number): number {
  let acc = 0;
  let last = -1;
  for (let a = 0; a < freqs.length; a++) {
    if (freqs[a] <= 0) continue;
    last = a;
    acc += freqs[a] * 100;
    if (roll <= acc) return a;
  }
  return last;
}

// --- Session history ----------------------------------------------------------------
// Just the graded decisions, not the solution they came from: a record points back at a
// node id + grid cell, and is only replayable while the same solution is loaded. Cheap
// enough to keep, and it is what the "worst first" review list reads.

export interface HandRecord {
  /** Node the decision was made at, for the "review in inspector" jump. */
  node: number;
  row: number;
  col: number;
  /** Hero's combo, e.g. `"AsKd"`. */
  cards: string;
  board: string;
  /** Chosen action's display text. */
  action: string;
  tier: Tier;
  evLoss: number;
  pctPot: number;
  freq: number;
}

const HISTORY_KEY = "solver-web.trainHistory";
const HISTORY_MAX = 200;

function isRecord(v: unknown): v is HandRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.node === "number" &&
    typeof r.row === "number" &&
    typeof r.col === "number" &&
    typeof r.cards === "string" &&
    typeof r.action === "string" &&
    typeof r.evLoss === "number" &&
    typeof r.pctPot === "number" &&
    typeof r.tier === "string" &&
    (TIERS as string[]).includes(r.tier)
  );
}

/** Best-effort: private browsing, disabled storage or a full quota must not break the trainer. */
export function saveHistory(rows: HandRecord[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(0, HISTORY_MAX)));
  } catch {
    // storage unavailable -- the session still works, it just won't survive a reload.
  }
}

export function loadHistory(): HandRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export interface SessionStats {
  hands: number;
  /** Graded "best" or "correct". */
  correct: number;
  /** `correct / hands`; 0 with no hands played. */
  accuracy: number;
  /** Mean EV loss as a fraction of pot; 0 with no hands played. */
  avgLossPct: number;
}

export function summarize(rows: HandRecord[]): SessionStats {
  if (rows.length === 0) return { hands: 0, correct: 0, accuracy: 0, avgLossPct: 0 };
  const correct = rows.filter((r) => r.tier === "best" || r.tier === "correct").length;
  const loss = rows.reduce((a, r) => a + r.pctPot, 0);
  return {
    hands: rows.length,
    correct,
    accuracy: correct / rows.length,
    avgLossPct: loss / rows.length,
  };
}
