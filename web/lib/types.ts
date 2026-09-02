// TypeScript shapes for the JSON strings the wasm API returns.
// Every field here was read off a real `solver_wasm` response, not guessed —
// see the doc comments in vendor/solver-wasm/solver_wasm.d.ts for the contract.

export type ActionLabel = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface NodeAction {
  label: ActionLabel;
  /** Display text the engine already formatted, e.g. `"bet to 10.00"`. */
  text: string;
  /** Street total the player is in for after the action; null for fold/check/call. */
  amount_to: number | null;
  /** Sizing as the config expresses it; null for fold/check/call. */
  percent_of_pot: number | null;
  child: number;
}

export interface TerminalFold {
  kind: "fold";
  folder: number;
  pot: number;
}
export interface TerminalShowdown {
  kind: "showdown";
  pot: number;
}

export interface NodeInfo {
  id: number;
  kind: "decision" | "chance" | "terminal";
  street: string;
  board: string[];
  pot: number;
  stacks: [number, number];
  /** decision only */
  player?: 0 | 1;
  /** decision only: this node's strategy was frozen by a config lock, not solved. */
  locked?: boolean;
  /** decision only */
  actions?: NodeAction[];
  /** chance only */
  valid_cards?: { card: string; child: number }[];
  /** terminal only */
  terminal?: TerminalFold | TerminalShowdown;
}

export interface Combo {
  /** Canonical 1326-combo index. */
  index: number;
  /** e.g. `"4cAc"` — NOT sorted by rank, parse both cards. */
  cards: string;
  /** Reach at this node: range weight x own average-strategy probs on the path. */
  weight: number;
}

export interface RootEvs {
  zero_sum: [number, number];
  pot_share: [number, number];
}

/** One node the solve froze, as `meta().locks` reports it. */
export interface LockInfo {
  node: number;
  player: 0 | 1;
  line: string;
}

/** The tournament structure a spot was scored against; `null` on a chip solve. */
export interface TournamentMeta {
  /** Chips behind per seat at the root of this node, in seat order. */
  stacks: number[];
  /** Prize per finishing place, index 0 = first. */
  payouts: number[];
  /** Indices into `stacks`: `[OOP seat, IP seat]`. */
  seats: [number, number];
  /** Pairwise `m[hero][villain]` at each pair's effective risk; `null` where not finite. */
  bubble_factors: (number | null)[][];
}

export interface Meta {
  format_version: number;
  engine_version: string;
  iterations: number;
  wall_seconds: number;
  exploitability_chips: number;
  exploitability_pct_of_pot: number;
  root_evs: RootEvs;
  node_count: number;
  board: string;
  street: string;
  starting_pot: number;
  effective_stack: number;
  oop_range: string;
  ip_range: string;
  root_combos: [number, number];
  /**
   * `"chips"` for an ordinary solve, `"cste"` when the spot was scored in tournament
   * equity. Absent on a pre-v3 solution file, which is by definition a chip solve.
   *
   * Under `"cste"` the game is general-sum: `exploitability_chips` holds **NashConv**,
   * the sum of both players' unilateral best-response gains, and is NOT a bound on
   * either player's loss. Nothing may label it exploitability.
   */
  payoff_unit?: "chips" | "cste";
  /** `[OOP, IP]` unilateral best-response gain; the two sum to `exploitability_chips`. */
  gain?: [number, number];
  /** The tournament structure, or `null`/absent on a chip solve. */
  tournament?: TournamentMeta | null;
  /** One entry per frozen decision node, in config order; empty for an ordinary solve. */
  locks: LockInfo[];
}

export interface TreeStats {
  nodes: {
    decision: number;
    chance: number;
    fold: number;
    showdown: number;
    total: number;
  };
  boards: number;
  root_combos: [number, number];
  strategy_entries: number;
  solver_storage_bytes: number;
  solution_strategy_bytes: number;
  chance_map_bytes: number;
  total_bytes: number;
  /** `[[locks]]` entries that resolved against the tree — the cheapest lock validation. */
  locks: number;
}

/** One step of the line walked from the root. */
export interface PathStep {
  /** Node we were at before taking this step. */
  from: number;
  /** Node we landed on. */
  to: number;
  /** Short label for the breadcrumb, e.g. `"OOP bet 10.00"` or `"turn 8h"`. */
  label: string;
  /** This step as `GameTree::resolve_line` parses it: `"bet:10"`, `"check"`, `"8h"`. */
  token: string;
  kind: "action" | "chance";
}

export const PLAYER_NAMES = ["OOP", "IP"] as const;
