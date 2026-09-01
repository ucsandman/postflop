// Solve form <-> the TOML the engine's `SolveConfig::from_toml_str` reads.
// Only keys the form exposes are emitted; everything else keeps the engine's own
// documented defaults (allin_threshold, raise_cap, DCFR alpha/beta/gamma, rake).

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

/**
 * The bundled river spot. It is deliberately tiny (12 nodes, 23 combos) so the
 * default form solves in milliseconds on the single browser thread.
 */
export const DEFAULT_FORM: SolveForm = {
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
};

/** Turn spot from `web-fixture.toml` — bigger, useful for exercising the preflight. */
export const TURN_FORM: SolveForm = {
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
};

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
