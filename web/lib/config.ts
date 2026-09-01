// Solve form <-> the TOML the engine's `SolveConfig::from_toml_str` reads.
// Only keys the form exposes are emitted; everything else keeps the engine's own
// documented defaults (allin_threshold, raise_cap, DCFR alpha/beta/gamma, rake).
import { canonicalRange, topWeights } from "./range.ts";

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
}

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
    },
  },
  {
    id: "turn-fixture",
    label: "Turn fixture — larger tree",
    note: "The spot in web-fixture.toml. Hand-written ranges, useful for exercising the preflight.",
    form: {
      board: "Qs Jh 2h 8c",
      oop_range: "22+,ATs+,KTs+,QTs+,JTs,T9s,98s,ATo+,KJo+",
      ip_range: "66+,A9s+,KTs+,QTs+,JTs,ATo+,KQo",
      effective_stack: "40",
      starting_pot: "6",
      max_iterations: "600",
      target_pct: "0.5",
      report_every: "50",
      sizings: (() => {
        const s = emptySizings();
        s.oop.flop.bet = "50";
        s.oop.turn.bet = "75";
        s.oop.river.bet = "75+";
        s.ip.flop.bet = "50";
        s.ip.flop.raise = "60";
        s.ip.turn.bet = "75";
        s.ip.river.bet = "75+";
        return s;
      })(),
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

export function toToml(form: SolveForm): string {
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
  return lines.join("\n") + "\n";
}

export const WARN_BYTES = 300 * 1024 * 1024;
export const HARD_BYTES = 1024 * 1024 * 1024;
