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
}

/** One step of the line walked from the root. */
export interface PathStep {
  /** Node we were at before taking this step. */
  from: number;
  /** Node we landed on. */
  to: number;
  /** Short label for the breadcrumb, e.g. `"OOP bet 10.00"` or `"turn 8h"`. */
  label: string;
  kind: "action" | "chance";
}

export const PLAYER_NAMES = ["OOP", "IP"] as const;
