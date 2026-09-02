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
   * then an unweighted mean over those combos, what the strategy *says*, not what
   * the range actually does here, and the cell is rendered muted.
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

export interface CellEv {
  /**
   * Weighted-average EV per action across this cell's live combos, weighted by
   * `combo_ev_weights` (reach x compatible opponent mass), the only weight that averages
   * EVs correctly. `NaN` when no combo in the cell has a defined EV for that action (the
   * opponent's range can't reach here compatibly).
   */
  actionEvs: number[];
  /** Index of the highest-`actionEvs` action, or -1 when the cell has no EV data at all. */
  bestAction: number;
  /**
   * Gap between the best and next-best `actionEvs`, in chips. `Infinity` when fewer than
   * two actions have a defined EV (nothing to be indifferent between, bestAction is
   * unambiguous). `NaN` when the cell has no EV data.
   */
  margin: number;
  /**
   * Weighted average, per combo, of (that combo's best action EV − its actual EV under
   * the solved mixed strategy), the chips left on the table by not always taking the
   * best action. Always >= 0. A combo only contributes when every action's EV is defined
   * for it; `NaN` when no combo in the cell qualifies.
   */
  regret: number;
}

/**
 * Per-cell action EVs and regret, for the "ev"/"regret" grid modes.
 *
 * `actionEvs[a]` is `combo_evs()` read at action `a`'s child node, the standard CFR
 * counterfactual value of taking that action, indexed by the same combo slot as
 * `combos`/`strategy` (action edges don't deal a card, so the child shares the parent's
 * live-combo list and ordering exactly; see `SolutionHandle::build`/`live_combos` in
 * engine/src/nlhe.rs).
 *
 * `evWeights` is `combo_ev_weights` read at THIS node (not `combos[i].weight`, which is
 * reach alone): averaging EVs needs reach x compatible opponent mass, or a cell's number
 * doesn't aggregate up to the range EV the engine reports, see
 * `SolutionHandle::combo_ev_weights`'s doc comment. The parent's weights are the right
 * ones for every action child: an action deals no card, so the opponent's reach and each
 * combo's compatible mass are unchanged, and a counterfactual value is by definition
 * taken as if the action were always chosen.
 */
export function buildEvGrid(
  cells: Cell[],
  evWeights: Float32Array,
  strategy: Float32Array,
  actionEvs: Float32Array[],
  numActions: number,
): CellEv[] {
  const n = evWeights.length;
  return cells.map((cell) => {
    const actionSum = new Float64Array(numActions);
    const actionWeight = new Float64Array(numActions);
    let regretSum = 0;
    let regretWeight = 0;

    for (const i of cell.slots) {
      // A zero-reach cell has zero EV weight too, so fall back to an unweighted mean
      // there, the same "what the strategy says, not what the range does" reading
      // `buildGrid` gives those cells.
      const w = cell.noReach ? 1 : evWeights[i];
      let allDefined = true;
      let best = -Infinity;
      let actual = 0;
      for (let a = 0; a < numActions; a++) {
        const v = actionEvs[a][i];
        if (Number.isNaN(v)) {
          allDefined = false;
          continue;
        }
        actionSum[a] += w * v;
        actionWeight[a] += w;
        if (v > best) best = v;
        actual += strategy[a * n + i] * v;
      }
      if (allDefined && numActions > 0) {
        regretSum += w * (best - actual);
        regretWeight += w;
      }
    }

    const avgEvs = Array.from({ length: numActions }, (_, a) =>
      actionWeight[a] > 0 ? actionSum[a] / actionWeight[a] : NaN,
    );

    let bestAction = -1;
    let bestVal = -Infinity;
    for (let a = 0; a < numActions; a++) {
      if (!Number.isNaN(avgEvs[a]) && avgEvs[a] > bestVal) {
        bestVal = avgEvs[a];
        bestAction = a;
      }
    }

    const defined = avgEvs.filter((v) => !Number.isNaN(v)).sort((x, y) => y - x);
    const margin = defined.length >= 2 ? defined[0] - defined[1] : defined.length === 1 ? Infinity : NaN;

    return {
      actionEvs: avgEvs,
      bestAction,
      margin,
      regret: regretWeight > 0 ? regretSum / regretWeight : NaN,
    };
  });
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

export interface BlockerScore {
  /** Reach-weighted frequency per action across every opponent combo. */
  unconditional: number[];
  /**
   * Same, restricted to opponent combos that don't share a card with the hero hand --
   * the frequency actually available once the hero's two cards are removed from the deck.
   */
  conditional: number[];
  /**
   * `conditional[a] - unconditional[a]`: how much holding these two cards shifts each
   * action's frequency. `+0.028` reads as "fold +2.8%".
   */
  delta: number[];
}

/**
 * Blocker/removal effect of one hero hand: how much excluding opponent combos that share
 * a card with `heroCards` shifts each action's reach-weighted frequency, relative to their
 * whole (unconditional) range. `oppCombos`/`oppStrategy`/`numActions` must all come from
 * the node where the opponent is the one deciding.
 */
export function blockerScores(
  oppCombos: Combo[],
  oppStrategy: Float32Array,
  numActions: number,
  heroCards: string,
): BlockerScore {
  const n = oppCombos.length;
  const h1 = heroCards.slice(0, 2);
  const h2 = heroCards.slice(2, 4);
  const conflicts = (cards: string) => {
    const c1 = cards.slice(0, 2);
    const c2 = cards.slice(2, 4);
    return c1 === h1 || c1 === h2 || c2 === h1 || c2 === h2;
  };

  const allAcc = new Float64Array(numActions);
  const condAcc = new Float64Array(numActions);
  let allDenom = 0;
  let condDenom = 0;
  for (let i = 0; i < n; i++) {
    const w = oppCombos[i].weight;
    allDenom += w;
    for (let a = 0; a < numActions; a++) allAcc[a] += w * oppStrategy[a * n + i];
    if (conflicts(oppCombos[i].cards)) continue;
    condDenom += w;
    for (let a = 0; a < numActions; a++) condAcc[a] += w * oppStrategy[a * n + i];
  }

  const unconditional =
    allDenom > 0 ? Array.from(allAcc, (v) => v / allDenom) : new Array(numActions).fill(0);
  const conditional =
    condDenom > 0 ? Array.from(condAcc, (v) => v / condDenom) : new Array(numActions).fill(0);
  return { unconditional, conditional, delta: unconditional.map((v, a) => conditional[a] - v) };
}

export interface RunoutHotness {
  /**
   * Child node id -> hero's reach-weighted mean EV there (the whole range, or just the
   * selected hand class when `selected` was given). `NaN` when nothing that qualifies
   * has a defined EV at that child.
   */
  evByChild: Map<number, number>;
  /** `evByChild` minus the across-runouts mean, same keys. `NaN` mirrors `evByChild`. */
  deviationByChild: Map<number, number>;
  /**
   * Largest finite `|deviation|` across all children, for color-scale normalization.
   * 0 when fewer than two children have a defined EV.
   */
  maxDeviation: number;
}

/**
 * Per-runout hero EV and its deviation from the across-runouts mean, for the runout
 * hotness overlay on the chance-node card grid.
 *
 * Each `children[i]` is one dealt-card outcome: its own live-combo list, `combo_evs`,
 * and `combo_ev_weights` for the hero, all read at that specific child node -- dealing a
 * card removes combos that share it, so both the live set and slot order differ child to
 * child, unlike an action edge (which deals no card and shares the parent's exactly).
 * `evWeights` (not `combos[i].weight`) is what averages EVs correctly -- see
 * `SolutionHandle::combo_ev_weights`'s doc comment.
 *
 * When `selected` is given, only combos whose grid cell matches it are folded in -- the
 * hotness for that one hand class rather than the whole range.
 */
export function buildRunoutHotness(
  children: { id: number; combos: Combo[]; evWeights: Float32Array; evs: Float32Array }[],
  selected: { row: number; col: number } | null,
): RunoutHotness {
  const evByChild = new Map<number, number>();
  for (const { id, combos, evWeights, evs } of children) {
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < combos.length; i++) {
      if (selected) {
        const cell = cellOf(combos[i].cards);
        if (cell.row !== selected.row || cell.col !== selected.col) continue;
      }
      const v = evs[i];
      if (Number.isNaN(v)) continue;
      sum += evWeights[i] * v;
      weight += evWeights[i];
    }
    evByChild.set(id, weight > 0 ? sum / weight : NaN);
  }

  const finite = Array.from(evByChild.values()).filter((v) => !Number.isNaN(v));
  const mean = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;

  const deviationByChild = new Map<number, number>();
  let maxDeviation = 0;
  for (const [id, v] of evByChild) {
    const d = Number.isNaN(v) ? NaN : v - mean;
    deviationByChild.set(id, d);
    if (!Number.isNaN(d)) maxDeviation = Math.max(maxDeviation, Math.abs(d));
  }

  return { evByChild, deviationByChild, maxDeviation };
}

// --- Colour scheme -------------------------------------------------------
// FOUR PLATES action inks. Bet is the heart-lit red, check the club-lit green,
// fold the diamond-lit blue: the three inks named in the ink key, and the same
// three the site prints. A bet ramp survives because sizing has to be readable,
// but every step stays unmistakably the bet ink, darkening as the sizing grows.
// A lone bet, the common case, gets BET_RAMP[0], which IS --color-bet.
//
// THREE steps, not five. The cell plate is #1E221C and the proportion-bar track is
// #262B24, and the whole dark-red gamut only spans 3.64:1 above that plate, so a
// five-step ramp put its last two steps at 1.59:1 and 1.20:1 on the plate and 1.08:1
// on the track: a full-frequency largest-sizing bet was indistinguishable from an
// empty bar. Three steps fit: 3.64:1, 2.95:1 and 2.33:1 on the plate, 2.06:1 or
// better on the track, with the same 1.2-1.3:1 between neighbours the five had.
const BET_RAMP = ["#e8202f", "#cd1727", "#b2101f"];
const FOLD = "#3b6bff";
const CHECK = "#00a95c";
const CALL = "#007a45";

/** The three named action inks, for legends that want one ink by name rather than a
 *  position in ACTION_INKS (whose length follows the bet ramp and has changed once). */
export const INK = { bet: BET_RAMP[0], check: CHECK, call: CALL, fold: FOLD };

/** The palette as a legend needs to read it: ink, and what that ink means. */
export const ACTION_INKS: [string, string][] = [
  [BET_RAMP[0], "bet or raise \u00b7 smallest sizing"],
  [BET_RAMP[1], "bet or raise \u00b7 middle sizing"],
  [BET_RAMP[2], "bet or raise \u00b7 largest sizing, and runout hotness, cold end"],
  [CHECK, "check"],
  [CALL, "call \u00b7 runout hotness, hot end"],
  [FOLD, "fold"],
];

/** Check and call carry the 45 degree overprint, so the mix reads without colour. */
export function hatched(label: string): boolean {
  return label === "check" || label === "call";
}

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

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** The raised plate every cell, chip and runout square is printed on. */
const PLATE: [number, number, number] = [30, 34, 28]; // #1E221C, --color-raised

/**
 * Mixes `hex` into the plate. `t=1` is the full ink, `t=0` is the bare plate.
 * Nothing in this identity fades toward a light stock: an ink weakens by sinking
 * back into the ground it is printed on.
 */
export function fadeToPlate(hex: string, t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(
    PLATE[0] + (r - PLATE[0]) * c,
    PLATE[1] + (g - PLATE[1]) * c,
    PLATE[2] + (b - PLATE[2]) * c,
  );
}

/**
 * Every single-ink ramp on the page runs between these two mixes. The ceiling is
 * not 1: past about 0.65 the stock-white cell label drops under 4.5:1 on the
 * lightest inks (check green, diamond blue), so the ink stays mixed with the plate.
 */
export const RAMP_LO = 0.12;
export const RAMP_HI = 0.65;

/** Maps a 0..1 strength onto the legible part of the ramp. */
export function rampMix(hex: string, t: number): string {
  const c = Math.max(0, Math.min(1, t));
  return fadeToPlate(hex, RAMP_LO + (RAMP_HI - RAMP_LO) * c);
}

/**
 * Color for the "ev" grid mode: the best action's own ink, sinking back into the plate
 * as its lead over the next-best action shrinks relative to `maxMargin` (the largest
 * margin anywhere on this grid). A clear-best hand prints at full strength, an
 * indifferent one nearly disappears. `null` when the cell has no EV data.
 */
export function evColor(cell: CellEv, colors: string[], maxMargin: number): string | null {
  if (cell.bestAction < 0) return null;
  const confidence =
    cell.margin === Infinity ? 1 : maxMargin > 0 ? Math.min(1, cell.margin / maxMargin) : 1;
  return rampMix(colors[cell.bestAction], confidence);
}

/** Heart-lit red: the ink regret is measured in. The same value as --color-err. */
const REGRET_INK = "#ff4d5a";

/**
 * Color for the "regret" grid mode: bare plate at zero EV lost, ramping up the
 * heart-lit red as `regret / maxRegret` (the worst regret anywhere on this grid)
 * approaches 1. `null` when the cell has no regret data.
 */
export function regretColor(regret: number, maxRegret: number): string | null {
  if (Number.isNaN(regret)) return null;
  const t = maxRegret > 0 ? Math.max(0, Math.min(1, regret / maxRegret)) : 0;
  return rampMix(REGRET_INK, t);
}

/**
 * Color for one runout in the hotness overlay: bare plate at the across-runouts mean EV,
 * rising into green as hero EV climbs above it and into red as it falls below, saturating
 * at `maxDeviation` (the largest `|deviation|` anywhere in this set of runouts). `null`
 * when `deviation` is `NaN` (no defined EV there) so the caller leaves the card plain.
 */
export function hotnessColor(deviation: number, maxDeviation: number): string | null {
  if (Number.isNaN(deviation)) return null;
  const t = maxDeviation > 0 ? Math.min(1, Math.abs(deviation) / maxDeviation) : 0;
  return rampMix(deviation >= 0 ? CALL : BET_RAMP[2], t);
}

/**
 * Chips this one combo leaves on the table by mixing instead of always taking its
 * best action: max_a ev_a − Σ_a strategy_a · ev_a. `NaN` when any action's EV is
 * undefined for this combo (same rule buildEvGrid applies per cell).
 */
export function comboRegret(
  actionEvs: Float32Array[],
  strategy: Float32Array,
  numActions: number,
  numCombos: number,
  slot: number,
): number {
  let best = -Infinity;
  let actual = 0;
  for (let a = 0; a < numActions; a++) {
    const v = actionEvs[a]?.[slot] ?? NaN;
    if (Number.isNaN(v)) return NaN;
    if (v > best) best = v;
    actual += strategy[a * numCombos + slot] * v;
  }
  return numActions > 0 ? best - actual : NaN;
}

/** Compact button/legend text for an action, e.g. `"bet 10.00"` / `"75% pot"`. */
export function actionShort(a: NodeAction): string {
  if (a.amount_to == null) return a.label;
  return `${a.label} ${a.amount_to.toFixed(2)}`;
}

export const fmtChips = (v: number) =>
  Number.isFinite(v) ? v.toFixed(2) : "–";
export const fmtPct = (v: number) =>
  Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "–";
export const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};
