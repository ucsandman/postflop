// 169-hand-class range editing: the strength ordering behind the top-X% slider,
// and the grid-weights <-> range-string canonicalisation the editor round-trips
// through the engine's own parser.
//
// Class indices match the Inspector's 13x13 grid exactly (see lib/grid.ts):
// `index = row * 13 + col`, pairs on the diagonal, suited above it, offsuit below.
// Nothing here talks to wasm; the only engine contact is that every string this
// module emits is fed back through `parse_range` and must survive unchanged.
import { RANKS, cellLabel, cellOf } from "./grid.ts";

export const NUM_CLASSES = 169;
export const NUM_COMBOS = 1326;

/** Combos a hand class contributes: 6 for a pair, 4 suited, 12 offsuit. */
export function comboCount(index: number): number {
  const row = Math.floor(index / 13);
  const col = index % 13;
  return row === col ? 6 : row < col ? 4 : 12;
}

export const CLASS_LABELS: readonly string[] = Array.from({ length: NUM_CLASSES }, (_, i) =>
  cellLabel(Math.floor(i / 13), i % 13),
);

const LABEL_INDEX = new Map(CLASS_LABELS.map((l, i) => [l, i]));

export function classIndex(label: string): number {
  const i = LABEL_INDEX.get(label);
  if (i === undefined) throw new Error(`not a hand class: ${label}`);
  return i;
}

/**
 * All 169 classes, strongest first.
 *
 * APPROXIMATE, and deliberately so: this is the conventional preflop hand-strength
 * ordering that study charts use for their "top X%" cuts — roughly heads-up equity
 * against a random hand, with the usual playability adjustments (suited hands promoted
 * over their offsuit twins, wheel aces A5s/A4s/A3s promoted for their straight and
 * nut-flush potential). It is *not* solver output and no engine produced it; it exists
 * only so the slider has a defensible order to walk. Two properties are enforced by
 * lib/range.test.ts because they are the ones the slider depends on: every class appears
 * exactly once, pairs descend AA -> 22, and every suited hand outranks its offsuit twin.
 */
export const HAND_ORDER: readonly string[] = [
  "AA", "KK", "QQ", "JJ", "TT", "AKs", "AKo", "AQs", "AJs", "KQs",
  "99", "ATs", "AQo", "KJs", "QJs", "KTs", "88", "QTs", "A9s", "JTs",
  "AJo", "KQo", "77", "A8s", "K9s", "T9s", "A5s", "Q9s", "J9s", "ATo",
  "A7s", "KJo", "66", "A4s", "98s", "QJo", "A6s", "A3s", "K8s", "T8s",
  "55", "J8s", "Q8s", "A2s", "KTo", "87s", "QTo", "JTo", "K7s", "97s",
  "44", "A9o", "76s", "T7s", "K6s", "J7s", "Q7s", "33", "86s", "22",
  "K5s", "65s", "A8o", "Q6s", "J6s", "T6s", "K9o", "96s", "54s", "K4s",
  "Q5s", "75s", "J9o", "A7o", "T9o", "K3s", "J5s", "Q4s", "85s", "64s",
  "K2s", "Q3s", "J4s", "T5s", "A6o", "98o", "53s", "A5o", "Q2s", "J3s",
  "T4s", "95s", "74s", "K8o", "43s", "J2s", "Q9o", "T3s", "87o", "63s",
  "84s", "A4o", "T2s", "52s", "J8o", "94s", "76o", "93s", "92s", "73s",
  "A3o", "Q8o", "83s", "K7o", "42s", "65o", "82s", "32s", "62s", "72s",
  "A2o", "T8o", "J7o", "K6o", "97o", "Q7o", "54o", "86o", "K5o", "J6o",
  "Q6o", "75o", "T7o", "K4o", "96o", "64o", "J5o", "Q5o", "K3o", "85o",
  "T6o", "53o", "K2o", "J4o", "Q4o", "43o", "95o", "T5o", "J3o", "74o",
  "Q3o", "63o", "J2o", "84o", "T4o", "52o", "Q2o", "32o", "94o", "T3o",
  "73o", "42o", "83o", "T2o", "93o", "62o", "92o", "82o", "72o",
];

/**
 * The strongest `pct` percent of the 1326 combos, as a 169-class weight vector of
 * 0/1. Whole classes only: a class is included when its combos still fit under the
 * cut, so the achieved percentage is <= `pct` (report the achieved one, not `pct`).
 */
export function topWeights(pct: number): number[] {
  const out = new Array<number>(NUM_CLASSES).fill(0);
  let combos = 0;
  for (const label of HAND_ORDER) {
    const i = classIndex(label);
    const n = comboCount(i);
    if ((100 * (combos + n)) / NUM_COMBOS > pct + 1e-9) break;
    combos += n;
    out[i] = 1;
  }
  return out;
}

/**
 * The chains a `+` or `-` token may span, each ordered strongest-first, because the
 * engine's `+` sweeps *up* from the named hand and its `-` walks between two hands of
 * the same kind: pairs by rank, then one suited chain per high card, then one offsuit
 * chain per high card. A run inside a chain is exactly what collapses to a token.
 */
const CHAINS: readonly (readonly number[])[] = (() => {
  const chains: number[][] = [Array.from({ length: 13 }, (_, r) => r * 13 + r)];
  for (const suited of [true, false]) {
    for (let hi = 0; hi < 12; hi++) {
      const chain: number[] = [];
      for (let lo = hi + 1; lo < 13; lo++) chain.push(suited ? hi * 13 + lo : lo * 13 + hi);
      chains.push(chain);
    }
  }
  return chains;
})();

/** Weights are quantised to 3 decimals: the grid paints in whole percents anyway, and
 *  equality has to be exact for a run to collapse into one token. */
const quantise = (w: number) => Math.round(Math.min(1, Math.max(0, w)) * 1000) / 1000;

/**
 * A 169-class weight vector as the shortest range string that parses back to it.
 *
 * Runs of equal weight inside a chain collapse: a run touching the strong end becomes
 * `22+` / `ATs+`, any other run of two or more becomes `99-66` / `A5s-A2s`, and a lone
 * class stays explicit. Partial weights get the engine's `:weight` suffix. Zero-weight
 * classes are simply not named — that is how the parser spells "not in the range".
 */
export function canonicalRange(weights: readonly number[]): string {
  const w = Array.from({ length: NUM_CLASSES }, (_, i) => quantise(weights[i] ?? 0));
  const tokens: string[] = [];
  for (const chain of CHAINS) {
    let i = 0;
    while (i < chain.length) {
      const weight = w[chain[i]];
      if (weight <= 0) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < chain.length && w[chain[j + 1]] === weight) j++;
      const first = CLASS_LABELS[chain[i]];
      const last = CLASS_LABELS[chain[j]];
      const shape = j === i ? first : i === 0 ? `${last}+` : `${first}-${last}`;
      tokens.push(weight < 1 ? `${shape}:${weight}` : shape);
      i = j + 1;
    }
  }
  return tokens.join(",");
}

/** Weighted combo count and its share of the 1326. Exact integers when every weight is 1. */
export function rangeSize(weights: readonly number[]): { combos: number; pct: number } {
  let combos = 0;
  for (let i = 0; i < NUM_CLASSES; i++) combos += (weights[i] ?? 0) * comboCount(i);
  return { combos, pct: (100 * combos) / NUM_COMBOS };
}

/** Canonical combo index -> class index, from `combo_labels()`'s `"AhKh"` strings. */
export function classMap(comboLabels: readonly string[]): Int16Array {
  const map = new Int16Array(comboLabels.length);
  for (let k = 0; k < comboLabels.length; k++) {
    const { row, col } = cellOf(comboLabels[k]);
    map[k] = row * 13 + col;
  }
  return map;
}

/**
 * Per-combo weights (1326, from `parse_range`) folded down to one weight per class.
 *
 * A class whose combos disagree — which only an explicit-combo token can produce —
 * collapses to their mean, so the grid shows something honest but lossy. The text row
 * stays the form's source of truth until the next grid edit, which is where the loss
 * would otherwise bite.
 */
export function classWeights(comboWeights: ArrayLike<number>, map: Int16Array): number[] {
  const sum = new Float64Array(NUM_CLASSES);
  const seen = new Float64Array(NUM_CLASSES);
  for (let k = 0; k < comboWeights.length; k++) {
    sum[map[k]] += comboWeights[k];
    seen[map[k]] += 1;
  }
  return Array.from(sum, (s, i) => (seen[i] > 0 ? s / seen[i] : 0));
}

/** `n` distinct random cards as a board string, e.g. `randomBoard(4)` -> `"Qs Jh 2h 8c"`. */
export function randomBoard(n: number, rng: () => number = Math.random): string {
  const deck: string[] = [];
  for (const r of RANKS) for (const s of "shdc") deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, n).join(" ");
}

/** A random valid 3-card flop, e.g. `"Qs Jh 2h"`. Three distinct cards, nothing more. */
export function randomFlop(): string {
  return randomBoard(3);
}
