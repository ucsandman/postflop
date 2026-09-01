// Solve form <-> the TOML the engine's `SolveConfig::from_toml_str` reads.
// Only keys the form exposes are emitted; everything else keeps the engine's own
// documented defaults (allin_threshold, raise_cap, DCFR alpha/beta/gamma, rake).
import { canonicalRange, topWeights } from "./range.ts";
import type { NodeAction, PathStep } from "./types.ts";

export const STREETS = ["flop", "turn", "river"] as const;
export const SEATS = ["oop", "ip"] as const;
export type Street = (typeof STREETS)[number];
export type Seat = (typeof SEATS)[number];

export type SizingGrid = Record<Seat, Record<Street, { bet: string; raise: string }>>;

export interface SolveForm {
  board: string;
  oop_range: string;
  ip_range: string;
  effective_stack: string;
  starting_pot: string;
  max_iterations: string;
  target_pct: string;
  report_every: string;
  sizings: SizingGrid;
  /** Table context the engine never sees — positions and the modeled player profiles.
   *  Display-only: `toToml` ignores it, so old saved forms without it load fine. */
  context?: SpotContext;
}

/** The profile one seat's range models. `vpip`/`pfr` are display strings ("24"), empty
 *  when nothing is modeled — the engine solves ranges, these label where they came from. */
export interface SeatProfile {
  /** Table position, e.g. "BTN", "BB" — or "OOP"/"IP" when there is no story. */
  pos: string;
  vpip: string;
  pfr: string;
}

export interface SpotContext {
  oop: SeatProfile;
  ip: SeatProfile;
  /** The preflop action that produced these ranges, e.g. "BTN opens 2.5bb, BB calls". */
  preflop: string;
}

export const EMPTY_CONTEXT: SpotContext = {
  oop: { pos: "OOP", vpip: "", pfr: "" },
  ip: { pos: "IP", vpip: "", pfr: "" },
  preflop: "",
};

const emptySizings = (): SizingGrid => ({
  oop: { flop: { bet: "", raise: "" }, turn: { bet: "", raise: "" }, river: { bet: "", raise: "" } },
  ip: { flop: { bet: "", raise: "" }, turn: { bet: "", raise: "" }, river: { bet: "", raise: "" } },
});

/** Flop 33/75 with a 60% raise, then 75% pot on turn and river, for both seats. */
const standardSizings = (): SizingGrid => {
  const s = emptySizings();
  for (const seat of SEATS) {
    s[seat].flop.bet = "33,75";
    s[seat].flop.raise = "60";
    s[seat].turn.bet = "75";
    s[seat].river.bet = "75";
  }
  return s;
};

/** The strongest `pct`% of combos as a range string — see lib/range.ts for the ordering. */
const top = (pct: number) => canonicalRange(topWeights(pct));

export interface Preset {
  id: string;
  label: string;
  /** One line of provenance, shown under the picker. */
  note: string;
  form: SolveForm;
}

/**
 * One-click spots.
 *
 * The preflop ranges are **approximate study ranges**, not solver output: each is the
 * strongest N% of combos under the conventional hand ordering in lib/range.ts, chosen
 * to sit in the width band the commonly circulated charts use for that seat. They are a
 * starting point for the grid editor, nothing more — no preflop solve produced them.
 *
 * Pot and stack are the real chip amounts those preflop actions leave behind at 100bb
 * (a 2.5bb open called leaves 5.5 in the middle and 97.5 behind, and so on).
 *
 * Every preset ships a TURN board rather than a flop, because a flop keeps two chance
 * streets in the tree: measured with tree_stats, the BTN-vs-BB spot below costs 3.3 MB
 * on `Qs Jh 2h 8c` and 1662 MB on `Qs Jh 2h`. Delete the last card and preflight it if
 * you want to see that bill for yourself.
 */
export const PRESETS: Preset[] = [
  {
    id: "btn-bb",
    label: "BTN raise vs BB call — single-raised, 100bb",
    note: "BTN opens 2.5bb, BB calls. IP ≈ top 45%, OOP ≈ top 33% — approximate, commonly used study ranges.",
    form: {
      board: "Qs Jh 2h 8c",
      oop_range: top(33),
      ip_range: top(45),
      effective_stack: "97.5",
      starting_pot: "5.5",
      max_iterations: "600",
      target_pct: "0.5",
      report_every: "50",
      sizings: standardSizings(),
      context: {
        ip: { pos: "BTN", vpip: "24", pfr: "19" },
        oop: { pos: "BB", vpip: "28", pfr: "13" },
        preflop: "BTN opens 2.5bb, BB calls",
      },
    },
  },
  {
    id: "co-btn",
    label: "CO raise vs BTN call — single-raised, 100bb",
    note: "CO opens 2.5bb and is out of position, BTN calls. OOP ≈ top 27%, IP ≈ top 25% — approximate, commonly used study ranges.",
    form: {
      board: "Th 8d 4c 2s",
      oop_range: top(27),
      ip_range: top(25),
      effective_stack: "97.5",
      starting_pot: "6.5",
      max_iterations: "600",
      target_pct: "0.5",
      report_every: "50",
      sizings: standardSizings(),
      context: {
        oop: { pos: "CO", vpip: "23", pfr: "18" },
        ip: { pos: "BTN", vpip: "26", pfr: "17" },
        preflop: "CO opens 2.5bb, BTN calls",
      },
    },
  },
  {
    id: "sb-bb",
    label: "SB raise vs BB call — heads-up, 3x, 100bb",
    note: "Heads-up the SB is the button, so the raiser plays in position. IP ≈ top 82%, OOP ≈ top 58% — approximate, commonly used study ranges.",
    form: {
      board: "Ks 9h 4d 2c",
      oop_range: top(58),
      ip_range: top(82),
      effective_stack: "97",
      starting_pot: "6",
      max_iterations: "400",
      target_pct: "0.5",
      report_every: "50",
      sizings: standardSizings(),
      context: {
        ip: { pos: "SB", vpip: "48", pfr: "32" },
        oop: { pos: "BB", vpip: "42", pfr: "14" },
        preflop: "Heads-up: SB (button) raises 3x, BB calls",
      },
    },
  },
  {
    id: "bb-3bet",
    label: "3-bet pot — BB 3-bets vs BTN call, 100bb",
    note: "BB 3-bets to 9bb over a 2.5bb BTN open and gets called. OOP ≈ top 12%, IP ≈ top 15% — approximate, commonly used study ranges.",
    form: {
      board: "Ah 7s 3d Tc",
      oop_range: top(12),
      ip_range: top(15),
      effective_stack: "91",
      starting_pot: "18.5",
      max_iterations: "600",
      target_pct: "0.5",
      report_every: "50",
      sizings: standardSizings(),
      context: {
        oop: { pos: "BB", vpip: "27", pfr: "15" },
        ip: { pos: "BTN", vpip: "25", pfr: "20" },
        preflop: "BTN opens 2.5bb, BB 3-bets to 9bb, BTN calls",
      },
    },
  },
  {
    id: "turn-fixture",
    label: "Turn fixture — the bundled sample, 100bb",
    note: "The spot in web-fixture.toml: BTN opens 2.5bb, BB calls, and the flop goes check-check. Same ranges as the BTN-vs-BB preset.",
    form: {
      board: "Qs Jh 2h 8c",
      oop_range: top(33),
      ip_range: top(45),
      effective_stack: "97.5",
      starting_pot: "5.5",
      max_iterations: "600",
      target_pct: "0.5",
      report_every: "50",
      sizings: (() => {
        const s = emptySizings();
        s.oop.turn.bet = "75";
        s.oop.river.bet = "75+";
        s.ip.turn.bet = "75";
        s.ip.turn.raise = "60";
        s.ip.river.bet = "75+";
        s.ip.river.raise = "60";
        return s;
      })(),
      context: {
        ip: { pos: "BTN", vpip: "24", pfr: "19" },
        oop: { pos: "BB", vpip: "28", pfr: "13" },
        preflop: "BTN opens 2.5bb, BB calls; flop checks through",
      },
    },
  },
  {
    id: "river-drill",
    label: "River polarisation drill — tiny",
    note: "12 nodes, 23 combos: a nutted-or-nothing OOP range against a capped IP one. Solves in milliseconds.",
    form: {
      board: "Ks 7d 2c 8h 3d",
      oop_range: "KK,A4s,A5s",
      ip_range: "TT,JJ",
      effective_stack: "20",
      starting_pot: "10",
      max_iterations: "2000",
      target_pct: "0.01",
      report_every: "100",
      sizings: (() => {
        const s = emptySizings();
        s.oop.river.bet = "100";
        s.ip.river.bet = "100";
        s.ip.river.raise = "100";
        return s;
      })(),
      context: {
        oop: { pos: "OOP", vpip: "", pfr: "" },
        ip: { pos: "IP", vpip: "", pfr: "" },
        preflop: "Constructed drill: polarized range against a capped one",
      },
    },
  },
];

/** What the Solve tab opens on: a real spot, already runnable, zero typing. */
export const DEFAULT_FORM: SolveForm = PRESETS[0].form;

/**
 * `"75+, 100"` -> percents [75, 100] with all-in also offered.
 * A trailing/embedded `+` anywhere in the field means "and all-in".
 */
export function parseSizing(text: string): { percents: number[]; allin: boolean } {
  const allin = text.includes("+");
  const percents = text
    .replace(/\+/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map(Number);
  if (percents.some((p) => !Number.isFinite(p) || p <= 0)) {
    throw new Error(`bad sizing "${text}": expected comma-separated positive percents, optional "+" for all-in`);
  }
  return { percents, allin };
}

const num = (name: string, raw: string): number => {
  const v = Number(raw.trim());
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number (got "${raw}")`);
  return v;
};

const quote = (s: string) => JSON.stringify(s);

// --- Node locks ---------------------------------------------------------------------
// A lock freezes one decision node's strategy and the engine solves the rest of the tree
// around it, so the result is an equilibrium *conditional* on that play. The engine reads
// them as `[[locks]]` tables; see `NodeLock` in engine/src/config.rs.

/** One step of a line as `GameTree::resolve_line` parses it: `"bet:10"`, `"check"`. */
export function actionToken(a: NodeAction): string {
  return a.amount_to == null ? a.label : `${a.label}:${a.amount_to}`;
}

/** A walked path as a lock `line` — `""` is the root, which is what the engine wants. */
export function lineOf(path: PathStep[]): string {
  return path.map((s) => s.token).join(",");
}

/**
 * The spot a lock was captured against, normalized so the same spot written differently
 * (`"QsJh2h8c"` vs `"Qs Jh 2h 8c"`) still matches: board, both ranges, stack and pot.
 *
 * A lock names its node only by the line walked from the root, and the engine's own
 * checks — `GameTree::resolve_lock` (player) and `NodeLock::expand` (action count, combo
 * count) — all pass just as happily on a *different* board of the same shape, which is
 * the common "same spot, new runout" edit. So the lock carries the spot it was read from
 * and `toToml` refuses to emit it against another one.
 *
 * Takes either a `SolveForm` or a solution's `meta()` (numbers or strings). Sizings are
 * not in `meta()` and so are not in the key; a changed bet size renames the line's own
 * `bet:<amount>` token, which makes the lock fail to resolve in the engine instead.
 */
export function spotKey(spot: {
  board: string;
  oop_range: string;
  ip_range: string;
  effective_stack: number | string;
  starting_pot: number | string;
}): string {
  const cards = (v: string) => v.replace(/[\s,]+/g, "").toLowerCase();
  return [
    cards(spot.board),
    cards(spot.oop_range),
    cards(spot.ip_range),
    Number(spot.effective_stack),
    Number(spot.starting_pot),
  ].join("|");
}

/** One pending lock: the node, and the distribution to freeze it at. */
export interface NodeLock {
  /** Path from the root; `""` is the root itself. */
  line: string;
  /** `spotKey` of the solution this strategy was read out of. */
  spot: string;
  /** Acting player at that node: 0 = OOP, 1 = IP. Cross-checked against the tree. */
  player: 0 | 1;
  /**
   * Action-major (`strategy[a * comboCount + i]`, length `numActions * comboCount`) —
   * exactly what `SolutionHandle.strategy(id)` hands out, so a strategy read out of a
   * solution locks back in unchanged.
   */
  strategy: number[];
  /** Human breadcrumb for the pending-lock list; the engine never sees it. */
  label: string;
}

/**
 * `[[locks]]` tables for the engine.
 *
 * Every probability is written with a decimal point: TOML types `0` as an integer and
 * serde then refuses it for the `Vec<f64>`. Six places keeps each combo's column inside
 * the engine's `LOCK_TOL` (1e-3) sum check with room to spare.
 */
function lockLines(locks: NodeLock[], spot: string): string[] {
  const out: string[] = [];
  for (const lock of locks) {
    if (lock.strategy.length === 0) throw new Error(`lock on "${lock.label}" has no strategy`);
    if (lock.spot !== spot) {
      throw new Error(
        `the lock on "${lock.label}" was captured on a different spot (board/ranges/stack/pot ` +
          `have changed since). Remove it, or restore the spot it came from, then solve.`,
      );
    }
    out.push(
      ``,
      `[[locks]]`,
      `line = ${quote(lock.line)}`,
      `player = ${lock.player}`,
      `strategy = [${lock.strategy.map((p) => p.toFixed(6)).join(", ")}]`,
    );
  }
  return out;
}

export function toToml(form: SolveForm, locks: NodeLock[] = []): string {
  if (!form.board.trim()) throw new Error("board is required");
  if (!form.oop_range.trim() || !form.ip_range.trim()) throw new Error("both ranges are required");

  const lines = [
    `board = ${quote(form.board.trim())}`,
    `oop_range = ${quote(form.oop_range.trim())}`,
    `ip_range = ${quote(form.ip_range.trim())}`,
    `effective_stack = ${num("effective stack", form.effective_stack)}`,
    `starting_pot = ${num("starting pot", form.starting_pot)}`,
    `max_iterations = ${Math.max(1, Math.round(num("max iterations", form.max_iterations)))}`,
    `target_exploitability = ${num("target exploitability", form.target_pct)}`,
  ];

  for (const seat of SEATS) {
    for (const street of STREETS) {
      const cell = form.sizings[seat][street];
      const bet = parseSizing(cell.bet);
      const raise = parseSizing(cell.raise);
      const hasBet = bet.percents.length > 0 || bet.allin;
      const hasRaise = raise.percents.length > 0 || raise.allin;
      if (!hasBet && !hasRaise) continue;
      lines.push(``, `[sizings.${seat}.${street}]`);
      if (hasBet)
        lines.push(`bet = { percents = [${bet.percents.map((p) => p.toFixed(1)).join(", ")}], allin = ${bet.allin} }`);
      if (hasRaise)
        lines.push(
          `raise = { percents = [${raise.percents.map((p) => p.toFixed(1)).join(", ")}], allin = ${raise.allin} }`,
        );
    }
  }
  lines.push(...lockLines(locks, spotKey(form)));
  return lines.join("\n") + "\n";
}

export const WARN_BYTES = 300 * 1024 * 1024;
export const HARD_BYTES = 1024 * 1024 * 1024;

// --- Solve-form session persistence -------------------------------------------------
// The form itself, not the solution it produces: rehydrating a multi-megabyte solution
// blob from localStorage on every page load is wasteful and the samples/export button
// already cover "get a solution back". Reload just needs the form as the user left it.

const FORM_STORAGE_KEY = "solver-web.solveForm";

/** Structural check, not a full schema validator -- catches a stale/corrupted blob from
 *  an older build without crashing the form on a missing sizing cell. */
function isSolveForm(v: unknown): v is SolveForm {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  if (typeof f.board !== "string" || typeof f.oop_range !== "string" || typeof f.ip_range !== "string") {
    return false;
  }
  const sizings = f.sizings as SizingGrid | undefined;
  if (!sizings || typeof sizings !== "object") return false;
  return SEATS.every((seat) =>
    STREETS.every((street) => {
      const cell = sizings[seat]?.[street];
      return !!cell && typeof cell.bet === "string" && typeof cell.raise === "string";
    }),
  );
}

/** Best-effort: private browsing, disabled storage, or a full quota must never break the form. */
export function saveForm(form: SolveForm): void {
  try {
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(form));
  } catch {
    // storage unavailable -- the form still works, it just won't survive a reload.
  }
}

/** The last form the user left the Solve tab in, or null if there's nothing usable. */
export function loadForm(): SolveForm | null {
  try {
    const raw = localStorage.getItem(FORM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSolveForm(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Which preset (if any) a form is still identical to -- "" once it's been hand-edited. */
export function findPresetId(form: SolveForm): string {
  const json = JSON.stringify(form);
  return PRESETS.find((p) => JSON.stringify(p.form) === json)?.id ?? "";
}
