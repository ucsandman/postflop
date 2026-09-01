// 13x13 range-grid aggregation and the action colour scheme.
//
// Everything here is arithmetic on numbers the engine produced. Nothing is
// smoothed, rounded for effect, or filled in when the engine has no answer.
import type { Combo, NodeAction } from "./types";

export const RANKS = "AKQJT98765432";
export const SUITS = "shdc";
export const SUIT_GLYPH: Record<string, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};
export const SUIT_CLASS: Record<string, string> = {
  s: "text-card-s",
  h: "text-card-h",
  d: "text-card-d",
  c: "text-card-c",
};

export function rankIndex(ch: string): number {
  return RANKS.indexOf(ch.toUpperCase());
}

/** `"4cAc"` -> `{ hi: 0 (A), lo: 10 (4), suited: true }`. Ranks are grid indices. */
export function comboCell(cards: string): { hi: number; lo: number; suited: boolean } {
  const a = rankIndex(cards[0]);
  const b = rankIndex(cards[2]);
  const suited = cards[1] === cards[3];
  return a <= b ? { hi: a, lo: b, suited } : { hi: b, lo: a, suited };
}

/** Grid coordinates: pairs on the diagonal, suited above it, offsuit below. */
export function cellOf(cards: string): { row: number; col: number } {
  const { hi, lo, suited } = comboCell(cards);
  if (hi === lo) return { row: hi, col: hi };
  return suited ? { row: hi, col: lo } : { row: lo, col: hi };
}

export function cellLabel(row: number, col: number): string {
  if (row === col) return RANKS[row] + RANKS[row];
  const hi = Math.min(row, col);
  const lo = Math.max(row, col);
  return RANKS[hi] + RANKS[lo] + (row < col ? "s" : "o");
}

export interface Cell {
  row: number;
  col: number;
  label: string;
  /** Sum of live combo reach weights in this cell. 0 means the line never gets here. */
  weight: number;
  /** Weighted action frequencies, summing to 1. Empty when the cell has no live combos. */
  freqs: number[];
  /** Slot indices into the node's combo array. */
  slots: number[];
  /**
   * True when the cell has live combos but zero total reach. The frequencies are
   * then an unweighted mean over those combos — what the strategy *says*, not what
   * the range actually does here — and the cell is rendered muted.
   */
  noReach: boolean;
}

/**
 * Fold a node's combo list + action-major strategy into the 169 grid cells.
 * `strategy[a * combos.length + i]` is P(action a | combo slot i).
 */
export function buildGrid(
  combos: Combo[],
  strategy: Float32Array,
  numActions: number,
): Cell[] {
  const n = combos.length;
  const cells: Cell[] = [];
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      cells.push({
        row,
        col,
        label: cellLabel(row, col),
        weight: 0,
        freqs: [],
        slots: [],
        noReach: false,
      });
    }
  }

  const acc = cells.map(() => new Float64Array(numActions));
  for (let i = 0; i < n; i++) {
    const { row, col } = cellOf(combos[i].cards);
    const cell = cells[row * 13 + col];
    cell.slots.push(i);
    cell.weight += combos[i].weight;
  }

  // Reach that's small relative to this node's own scale is real (a node deep in a
  // long line can have every combo's reach diluted); reach that's small relative to
  // the OTHER cells at this same node is float noise from a dead line the engine
  // still backfills with an exactly-uniform strategy. So the guard is relative to
  // the node's own max cell weight, not an absolute cutoff.
  const maxCellWeight = Math.max(0, ...cells.map((c) => c.weight));
  const NO_REACH_REL_EPS = 1e-6;
  for (const cell of cells) {
    if (cell.slots.length === 0) continue;
    const useReach = cell.weight > NO_REACH_REL_EPS * maxCellWeight;
    cell.noReach = !useReach;
    const bucket = acc[cell.row * 13 + cell.col];
    let denom = 0;
    for (const i of cell.slots) {
      const w = useReach ? combos[i].weight : 1;
      denom += w;
      for (let a = 0; a < numActions; a++) bucket[a] += w * strategy[a * n + i];
    }
    if (denom > 0) cell.freqs = Array.from(bucket, (v) => v / denom);
  }
  return cells;
}

/** Per-combo action distribution at a slot. */
export function comboFreqs(
  strategy: Float32Array,
  numActions: number,
  numCombos: number,
  slot: number,
): number[] {
  const out: number[] = [];
  for (let a = 0; a < numActions; a++) out.push(strategy[a * numCombos + slot]);
  return out;
}

/** Range-wide frequency of each action, weighted by reach. */
export function rangeFreqs(
  combos: Combo[],
  strategy: Float32Array,
  numActions: number,
): number[] {
  const n = combos.length;
  const acc = new Float64Array(numActions);
  let denom = 0;
  for (let i = 0; i < n; i++) {
    const w = combos[i].weight;
    denom += w;
    for (let a = 0; a < numActions; a++) acc[a] += w * strategy[a * n + i];
  }
  if (denom <= 0) return new Array(numActions).fill(0);
  return Array.from(acc, (v) => v / denom);
}

// --- Colour scheme -------------------------------------------------------
// Aggression reds get darker as the sizing grows; passive actions are green
// (check light, call dark); folding is a cold slate. Consistent everywhere.

const BET_RAMP = ["#e2705c", "#d1462f", "#ad2413", "#83140a", "#570b05"];
const FOLD = "#48566f";
const CHECK = "#54ad72";
const CALL = "#2b7c50";

export function actionColors(actions: NodeAction[]): string[] {
  const aggressive: number[] = [];
  actions.forEach((a, i) => {
    if (a.label === "bet" || a.label === "raise" || a.label === "allin") aggressive.push(i);
  });
  // Rank by sizing so the same visual weight always means the same relative size.
  const order = [...aggressive].sort(
    (x, y) =>
      (actions[x].percent_of_pot ?? Number.POSITIVE_INFINITY) -
      (actions[y].percent_of_pot ?? Number.POSITIVE_INFINITY),
  );
  const rank = new Map<number, number>();
  order.forEach((idx, k) => rank.set(idx, k));

  return actions.map((a, i) => {
    if (a.label === "fold") return FOLD;
    if (a.label === "check") return CHECK;
    if (a.label === "call") return CALL;
    const k = rank.get(i) ?? 0;
    const span = Math.max(order.length - 1, 1);
    const slot = Math.round((k / span) * (BET_RAMP.length - 1));
    return BET_RAMP[Math.min(slot, BET_RAMP.length - 1)];
  });
}

/** Compact button/legend text for an action, e.g. `"bet 10.00"` / `"75% pot"`. */
export function actionShort(a: NodeAction): string {
  if (a.amount_to == null) return a.label;
  return `${a.label} ${a.amount_to.toFixed(2)}`;
}

export const fmtChips = (v: number) =>
  Number.isFinite(v) ? v.toFixed(2) : "—";
export const fmtPct = (v: number) =>
  Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—";
export const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};
