//! Browser bindings for the solver engine.
//!
//! Two ways in, one type out:
//!
//! * [`load_solution`] parses a saved `Solution` JSON document, runs its structure
//!   guard, and rebuilds the tree and board tables from the embedded config.
//! * [`solve_spot`] runs Discounted CFR in the browser and snapshots the result into the
//!   same `Solution`, so both paths hand back an identical [`SolutionHandle`] and a
//!   solved handle round-trips through `to_json()` -> `load_solution`.
//!
//! # Conventions this module commits to
//!
//! * **Errors are thrown JS strings**, never panics. A panic in wasm is unrecoverable —
//!   the module is poisoned and the page must reload — so every entry point validates
//!   its input and returns `Err(JsValue::from_str(..))` instead.
//!   [`console_error_panic_hook`] is installed anyway so that a bug that slips through
//!   prints something readable rather than `RuntimeError: unreachable`.
//! * **`-> JSON` means a JSON string.** `JSON.parse()` it. Bulk numeric data
//!   (strategies, EVs, weights) comes back as a `Float32Array` instead, with no copy on
//!   the Rust side beyond the one wasm-bindgen makes.
//! * **Chip amounts are chips**, in the same units as the config's `starting_pot` and
//!   `effective_stack`.
//! * **`player` is 0 for OOP, 1 for IP** everywhere, matching the engine.
//!
//! # Memory
//!
//! The solver holds two `f32` arrays — cumulative regret and cumulative strategy — of
//! `num_actions * live_combos` entries per decision node, so **8 bytes per
//! (action, combo) pair**, plus the shared chance maps. A full flop tree runs to
//! gigabytes and will not fit in a browser tab. Call [`tree_stats`] first: it builds the
//! tree and board tables (cheap) but never the solver arrays, and reports the exact byte
//! counts so the UI can refuse or warn before [`solve_spot`] tries to allocate them.

use std::collections::HashMap;

use engine::br::{self, StrategyProfile};
use engine::cards::{self, NUM_CARDS};
use engine::cfr::{DcfrParams, Solver};
use engine::config::SolveConfig;
use engine::game::Game;
use engine::nlhe::NlheGame;
use engine::range::{self, Range, NUM_COMBOS};
use engine::solution::{NodeStrategy, Solution};
use engine::tree::{Action, ActionLabel, GameTree, NodeKind, Terminal, NO_CHILD};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn err(msg: impl AsRef<str>) -> JsValue {
    JsValue::from_str(msg.as_ref())
}

// =====================================================================================
// Entry points
// =====================================================================================

/// Parses and validates a saved solution document.
///
/// `json` is the text of a file written by `Solution::save` / [`SolutionHandle::to_json`].
/// The engine's structure guard runs first (node count, per-node acting player, action
/// count and array length against a tree rebuilt from the embedded config); this then
/// additionally checks that **every** decision node in the rebuilt tree carries a
/// strategy of the right combo width, because a gap there would panic later inside the
/// best-response walk, and a wasm panic cannot be caught.
#[wasm_bindgen]
pub fn load_solution(json: &str) -> Result<SolutionHandle, JsValue> {
    let sol = Solution::from_reader(json.as_bytes()).map_err(err)?;
    SolutionHandle::build(sol).map_err(err)
}

/// Preflight for [`solve_spot`]: what this config would cost, without solving it.
///
/// Builds the tree and per-board combo tables — the same setup a solve does — but never
/// allocates the solver's regret/strategy arrays. Returns a JSON string:
///
/// ```json
/// {
///   "nodes": { "decision": 3, "chance": 0, "fold": 2, "showdown": 2, "total": 12 },
///   "boards": 1,
///   "root_combos": [11, 12],
///   "strategy_entries": 46,
///   "solver_storage_bytes": 368,
///   "solution_strategy_bytes": 184,
///   "chance_map_bytes": 0,
///   "total_bytes": 368
/// }
/// ```
///
/// `locks` is the number of `[[locks]]` entries in the config that resolved, and is the
/// cheapest way to find out whether a config's locks are well formed: this call builds
/// the tree, so a bad line or a mis-shaped distribution is reported here rather than
/// after a solve has been paid for.
///
/// `strategy_entries` is the number of (action, combo) pairs over all decision nodes.
/// `solver_storage_bytes` is `entries * 2 * 4` — the regret and cumulative-strategy
/// arrays a solve needs resident. `solution_strategy_bytes` is `entries * 4`, the size
/// of the strategy payload in the exported JSON's numeric form (the text encoding is
/// several times larger). `total_bytes` is `solver_storage_bytes + chance_map_bytes`,
/// the figure to compare against a browser's budget.
#[wasm_bindgen]
pub fn tree_stats(config_toml: &str) -> Result<String, JsValue> {
    let cfg = SolveConfig::from_toml_str(config_toml).map_err(err)?;
    let game = NlheGame::new(&cfg).map_err(err)?;
    let tree = game.tree();
    let counts = tree.counts();

    let mut entries = 0usize;
    for idx in 0..tree.len() as u32 {
        if let NodeKind::Decision { player, actions } = &tree.node(idx).kind {
            entries += actions.len() * game.live_combos(idx, *player).len();
        }
    }
    let solver_bytes = entries * 2 * std::mem::size_of::<f32>();
    let map_bytes = game.chance_map_bytes();
    let root = game.root();

    Ok(json!({
        "nodes": {
            "decision": counts.decision,
            "chance": counts.chance,
            "fold": counts.fold,
            "showdown": counts.showdown,
            "total": counts.total,
        },
        "boards": game.num_boards(),
        "locks": game.locked_nodes().len(),
        "root_combos": [
            game.live_combos(root, 0).len(),
            game.live_combos(root, 1).len(),
        ],
        "strategy_entries": entries,
        "solver_storage_bytes": solver_bytes,
        "solution_strategy_bytes": entries * std::mem::size_of::<f32>(),
        "chance_map_bytes": map_bytes,
        "total_bytes": solver_bytes + map_bytes,
    })
    .to_string())
}

/// Solves a spot in the browser and returns a handle on the result.
///
/// `config_toml` is the same TOML the CLI reads. `max_iterations` and `target_pct`
/// override the config's own `max_iterations` / `target_exploitability`: the run stops at
/// whichever comes first, `target_pct` being exploitability as a **percent of the pot**.
///
/// `report_every` is both the progress interval and the granularity of the stop check, so
/// it must be at least 1. Each report costs two full best-response walks — keep it coarse.
///
/// `on_progress(iteration, exploitability_chips, exploitability_pct_of_pot)` is called on
/// the calling thread; an exception it throws is swallowed so a UI bug cannot abandon a
/// half-finished solve. There is no yielding: this blocks until the run ends, so drive it
/// from a Web Worker if the page must stay responsive.
///
/// Call [`tree_stats`] first. This allocates `solver_storage_bytes` up front, and a
/// failed allocation in wasm aborts the module rather than returning an error.
///
/// # Node locking
///
/// `[[locks]]` entries in the TOML freeze the acting player's strategy at the nodes
/// their lines name, and the rest of the tree is solved around them — see
/// [`engine::config::NodeLock`] for the syntax. There is no separate argument: the locks
/// are part of the spot, they travel in the config the returned handle embeds, and
/// `to_json()` -> [`load_solution`] reproduces the same constrained game. A locked node's
/// `strategy(id)` is the frozen distribution exactly, and `meta().locks` says which nodes
/// they are. Exploitability then means exploitability *given* the locks; see the
/// `engine::br` module docs.
#[wasm_bindgen]
pub fn solve_spot(
    config_toml: &str,
    max_iterations: u32,
    target_pct: f64,
    report_every: u32,
    on_progress: &js_sys::Function,
) -> Result<SolutionHandle, JsValue> {
    if max_iterations == 0 {
        return Err(err("max_iterations must be at least 1"));
    }
    if report_every == 0 {
        return Err(err(
            "report_every must be at least 1 (it drives the stop-condition check)",
        ));
    }

    let mut cfg = SolveConfig::from_toml_str(config_toml).map_err(err)?;
    cfg.max_iterations = max_iterations as u64;
    cfg.target_exploitability = target_pct;
    cfg.validate().map_err(err)?;
    if cfg.turn_chance_sampling {
        return Err(err(
            "turn_chance_sampling is set, but exact search is the only mode implemented \
             - refusing to silently approximate",
        ));
    }

    let game = NlheGame::new(&cfg).map_err(err)?;
    let params = DcfrParams::from_config(&cfg);
    let mut solver = Solver::new(game);

    let t0 = js_sys::Date::now();
    let mut done = 0u64;
    let mut last_pct = f64::INFINITY;
    while done < cfg.max_iterations {
        let chunk = (report_every as u64).min(cfg.max_iterations - done);
        solver.run(chunk, &params, chunk, |i, chips, pct| {
            last_pct = pct as f64;
            let _ = on_progress.call3(
                &JsValue::NULL,
                &JsValue::from_f64(i as f64),
                &JsValue::from_f64(chips as f64),
                &JsValue::from_f64(pct as f64),
            );
        });
        done += chunk;
        if last_pct <= target_pct {
            break;
        }
    }
    let wall_seconds = (js_sys::Date::now() - t0) / 1000.0;

    SolutionHandle::build(Solution::from_solver(&solver, wall_seconds)).map_err(err)
}

/// Expands a range string into per-combo weights, for a range-editor preview grid.
///
/// `"random"` (any case) is the full 1326-combo range; anything else is standard range
/// notation. Returns a JSON string
/// `{"num_combos":1326,"nonzero":N,"total_weight":W,"weights":[...1326 floats...]}`,
/// indexed by canonical combo index — the same index [`combo_labels`] labels and the
/// same one [`SolutionHandle::combos`] reports per slot.
#[wasm_bindgen]
pub fn parse_range(range: &str) -> Result<String, JsValue> {
    let parsed = if range.trim().eq_ignore_ascii_case("random") {
        Range::uniform_full()
    } else {
        Range::parse(range).map_err(err)?
    };
    let weights = parsed.weights();
    Ok(json!({
        "num_combos": NUM_COMBOS,
        "nonzero": weights.iter().filter(|w| **w > 0.0).count(),
        "total_weight": weights.iter().sum::<f32>(),
        "weights": weights,
    })
    .to_string())
}

/// The 1326 canonical combo labels (`"AhKh"`) in combo-index order, as a JSON array.
///
/// Call once and cache: it is the axis every weight array from [`parse_range`] is
/// indexed by.
#[wasm_bindgen]
pub fn combo_labels() -> String {
    let labels: Vec<String> = (0..NUM_COMBOS)
        .map(|i| {
            let (a, b) = range::combo_cards(i);
            format!("{}{}", cards::card_to_string(a), cards::card_to_string(b))
        })
        .collect();
    json!(labels).to_string()
}

// =====================================================================================
// The handle
// =====================================================================================

/// How a node was reached from its parent — the two ways a reach vector changes.
#[derive(Clone, Copy)]
enum Edge {
    /// Action index at a decision node.
    Action(u32),
    /// Outcome index at a chance node. Outcomes are ascending by card, which is exactly
    /// the order live entries appear in `NodeKind::Chance::child_for_card`.
    Chance(u32),
}

/// A loaded or freshly solved spot: the strategies, plus everything needed to answer
/// questions about them without re-solving.
#[wasm_bindgen]
pub struct SolutionHandle {
    sol: Solution,
    game: NlheGame,
    /// Node index -> position in `sol.nodes`.
    by_node: HashMap<u32, usize>,
    /// Node index -> (parent, edge taken). `None` at the root.
    parents: Vec<Option<(u32, Edge)>>,
}

impl SolutionHandle {
    fn build(sol: Solution) -> Result<SolutionHandle, String> {
        let game = NlheGame::new(&sol.config)?;
        let tree = game.tree();
        let by_node: HashMap<u32, usize> =
            sol.nodes.iter().enumerate().map(|(i, n)| (n.node, i)).collect();

        // The engine's structure guard checks the nodes the file *does* carry. This
        // checks the ones it must not omit, and that each one's combo axis matches the
        // live combos this board actually has — both are lengths the best-response walk
        // would otherwise trip over with an unrecoverable panic.
        for idx in 0..tree.len() as u32 {
            let NodeKind::Decision { player, actions } = &tree.node(idx).kind else {
                continue;
            };
            let &i = by_node.get(&idx).ok_or_else(|| {
                format!("solution has no strategy for decision node {idx}")
            })?;
            let ns = &sol.nodes[i];
            let live = game.live_combos(idx, *player).len();
            if ns.combo_count as usize != live {
                return Err(format!(
                    "node {idx}: solution stores {} combos for player {player}, but this \
                     board has {live} live",
                    ns.combo_count
                ));
            }
            if ns.strategy.len() != actions.len() * live {
                return Err(format!(
                    "node {idx}: strategy has {} entries, expected {} actions * {live} combos",
                    ns.strategy.len(),
                    actions.len()
                ));
            }
        }

        let mut parents = vec![None; tree.len()];
        for idx in 0..tree.len() as u32 {
            match &tree.node(idx).kind {
                NodeKind::Decision { actions, .. } => {
                    for (a, act) in actions.iter().enumerate() {
                        parents[act.child as usize] = Some((idx, Edge::Action(a as u32)));
                    }
                }
                NodeKind::Chance { child_for_card, .. } => {
                    let mut k = 0u32;
                    for &child in child_for_card.iter() {
                        if child != NO_CHILD {
                            parents[child as usize] = Some((idx, Edge::Chance(k)));
                            k += 1;
                        }
                    }
                }
                NodeKind::Terminal(_) => {}
            }
        }

        Ok(SolutionHandle { sol, game, by_node, parents })
    }

    fn profile(&self) -> FileProfile<'_> {
        FileProfile { nodes: &self.sol.nodes, by_node: &self.by_node }
    }

    fn check_node(&self, id: u32) -> Result<(), JsValue> {
        if id as usize >= self.game.tree().len() {
            return Err(err(format!(
                "node {id} is out of range (tree has {} nodes)",
                self.game.tree().len()
            )));
        }
        Ok(())
    }

    fn check_player(&self, player: u8) -> Result<(), JsValue> {
        if player > 1 {
            return Err(err(format!("player must be 0 (OOP) or 1 (IP), got {player}")));
        }
        Ok(())
    }

    /// Root -> `node`, as `(node, edge out of it)` pairs in order.
    fn path_to(&self, node: u32) -> Vec<(u32, Edge)> {
        let mut path = Vec::new();
        let mut cur = node;
        while let Some((parent, edge)) = self.parents[cur as usize] {
            path.push((parent, edge));
            cur = parent;
        }
        path.reverse();
        path
    }

    /// Player `player`'s reach vector at `node`, one entry per live combo there.
    ///
    /// Root range weights, multiplied by that player's own average-strategy probability
    /// for every action taken on the path, compacted across each chance edge onto the
    /// child's shorter combo list.
    ///
    /// `with_chance_weight` also folds in the deal probabilities. That belongs in the
    /// *opponent's* vector, which is the one `br::subtree_values` consumes and the one
    /// that carries chance mass by the engine's convention; a display weight leaves it
    /// out so the numbers stay on the range's own scale.
    fn reach(&self, node: u32, player: u8, with_chance_weight: bool) -> Vec<f32> {
        let mut cur = self.game.root_weights(player).to_vec();
        for (n, edge) in self.path_to(node) {
            match edge {
                Edge::Action(a) => {
                    let NodeKind::Decision { player: mover, .. } = &self.game.tree().node(n).kind
                    else {
                        continue;
                    };
                    if *mover != player {
                        continue;
                    }
                    let Some(&i) = self.by_node.get(&n) else { continue };
                    let strategy = &self.sol.nodes[i].strategy;
                    let width = cur.len();
                    let base = a as usize * width;
                    for (i, w) in cur.iter_mut().enumerate() {
                        *w *= strategy[base + i];
                    }
                }
                Edge::Chance(k) => {
                    let edge = self.game.chance_outcome(n, k as usize);
                    let map = edge.parent_of_child[player as usize];
                    let weight = if with_chance_weight { edge.weight } else { 1.0 };
                    cur = map.iter().map(|&p| cur[p as usize] * weight).collect();
                }
            }
        }
        cur
    }
}

#[wasm_bindgen]
impl SolutionHandle {
    /// Number of nodes in the tree. Valid ids are `0 .. node_count()`.
    #[wasm_bindgen(getter)]
    pub fn node_count(&self) -> u32 {
        self.sol.node_count
    }

    /// Solve metadata and the headline numbers, as a JSON string:
    /// `format_version`, `engine_version`, `iterations`, `wall_seconds`,
    /// `exploitability_chips`, `exploitability_pct_of_pot`, `root_evs`
    /// (both conventions), `node_count`, `board`, `street`, `starting_pot`,
    /// `effective_stack`, `oop_range`, `ip_range`, `root_combos` (counts per player),
    /// and `locks`.
    ///
    /// `locks` is one `{node, player, line}` per frozen decision node, in config order —
    /// empty for an ordinary solve. Those nodes' strategies are the locked distributions
    /// rather than solved ones, which is what a UI badge should say, and
    /// `exploitability_*` is measured against the locked profile.
    pub fn meta(&self) -> String {
        let m = &self.sol.meta;
        let cfg = &self.sol.config;
        let root = self.game.root();
        json!({
            "format_version": self.sol.format_version,
            "engine_version": m.engine_version,
            "iterations": m.iterations,
            "wall_seconds": m.wall_seconds,
            "exploitability_chips": m.exploitability_chips,
            "exploitability_pct_of_pot": m.exploitability_pct_of_pot,
            "root_evs": {
                "zero_sum": m.root_evs.zero_sum,
                "pot_share": m.root_evs.pot_share,
            },
            "node_count": self.sol.node_count,
            "board": cards::cards_to_string(self.game.tree().board()),
            "street": self.game.tree().starting_street(),
            "starting_pot": cfg.starting_pot,
            "effective_stack": cfg.effective_stack,
            "oop_range": cfg.oop_range,
            "ip_range": cfg.ip_range,
            "root_combos": [
                self.game.live_combos(root, 0).len(),
                self.game.live_combos(root, 1).len(),
            ],
            "locks": self
                .game
                .locked_nodes()
                .iter()
                .zip(&cfg.locks)
                .map(|(node, lock)| json!({
                    "node": node,
                    "player": lock.player,
                    "line": lock.line,
                }))
                .collect::<Vec<Value>>(),
        })
        .to_string()
    }

    /// Root EVs in both display conventions, as a JSON string
    /// `{"zero_sum":[oop,ip],"pot_share":[oop,ip]}`.
    ///
    /// `zero_sum` is net chips against the start of the solve and sums to 0 (less rake).
    /// `pot_share` is the PioSOLVER-style pot-inclusive figure and sums to the starting
    /// pot. Both are per hand, averaged over each player's whole range.
    pub fn root_evs(&self) -> String {
        let e = &self.sol.meta.root_evs;
        json!({ "zero_sum": e.zero_sum, "pot_share": e.pot_share }).to_string()
    }

    /// Everything public about one node, as a JSON string.
    ///
    /// Always: `id`, `kind` (`"decision"`/`"chance"`/`"terminal"`), `street`, `board`
    /// (card strings known at this node), `pot`, `stacks` `[oop, ip]`.
    ///
    /// Decision nodes add `player`, `locked` (true when this node's strategy was frozen
    /// by a config lock rather than solved), and `actions`, each
    /// `{label, text, amount_to, percent_of_pot, child}` — `label` is one of
    /// `fold`/`check`/`call`/`bet`/`raise`/`allin`; `amount_to` is the street total the
    /// player has in after the action (bet/raise only, else `null`); `percent_of_pot` is
    /// the sizing as the config expresses it — against the pot at this node for a bet,
    /// against the post-call pot for a raise (`null` otherwise).
    ///
    /// Chance nodes add `valid_cards`, one `{card, child}` per card that can still be
    /// dealt (every card not already on `board`).
    ///
    /// Terminal nodes add `terminal`: `{"kind":"fold","folder":p,"pot":x}` where `pot` is
    /// the matched pot with the uncalled bet already returned, or
    /// `{"kind":"showdown","pot":x}`.
    pub fn node(&self, id: u32) -> Result<String, JsValue> {
        self.check_node(id)?;
        let tree = self.game.tree();
        let n = tree.node(id);
        let board: Vec<String> = self
            .game
            .board_at(id)
            .iter()
            .map(|&c| cards::card_to_string(c))
            .collect();

        let mut v = json!({
            "id": id,
            "street": n.street,
            "board": board,
            "pot": n.pot,
            "stacks": n.stacks,
        });
        let obj = v.as_object_mut().expect("json! built an object");

        match &n.kind {
            NodeKind::Decision { player, actions } => {
                obj.insert("kind".into(), json!("decision"));
                obj.insert("player".into(), json!(player));
                obj.insert("locked".into(), json!(self.game.locked_strategy(id).is_some()));
                let list: Vec<Value> = actions
                    .iter()
                    .map(|a| action_json(tree, id, *player, actions, a))
                    .collect();
                obj.insert("actions".into(), json!(list));
            }
            NodeKind::Chance { child_for_card, .. } => {
                obj.insert("kind".into(), json!("chance"));
                let list: Vec<Value> = (0..NUM_CARDS)
                    .filter(|&c| child_for_card[c] != NO_CHILD)
                    .map(|c| {
                        json!({
                            "card": cards::card_to_string(c as u8),
                            "child": child_for_card[c],
                        })
                    })
                    .collect();
                obj.insert("valid_cards".into(), json!(list));
            }
            NodeKind::Terminal(t) => {
                obj.insert("kind".into(), json!("terminal"));
                obj.insert(
                    "terminal".into(),
                    match t {
                        Terminal::Fold { folder, pot } => {
                            json!({ "kind": "fold", "folder": folder, "pot": pot })
                        }
                        Terminal::Showdown { pot } => json!({ "kind": "showdown", "pot": pot }),
                    },
                );
            }
        }
        Ok(v.to_string())
    }

    /// Actions at a decision node; 0 at a chance or terminal node.
    pub fn num_actions(&self, id: u32) -> Result<usize, JsValue> {
        self.check_node(id)?;
        Ok(match &self.game.tree().node(id).kind {
            NodeKind::Decision { actions, .. } => actions.len(),
            _ => 0,
        })
    }

    /// Live combos `player` can hold at `id` — the combo axis of every array below.
    pub fn combo_count(&self, id: u32, player: u8) -> Result<usize, JsValue> {
        self.check_node(id)?;
        self.check_player(player)?;
        Ok(self.game.live_combos(id, player).len())
    }

    /// The average strategy at decision node `id` as a `Float32Array`, **action-major**:
    /// `strategy[a * combo_count(id, player) + i]` is the probability the acting player
    /// takes action `a` with combo slot `i`. Each combo's entries sum to 1.
    ///
    /// A combo that never reached this node is reported uniform over the actions, which
    /// is the engine's convention, not a solved frequency.
    pub fn strategy(&self, id: u32) -> Result<Vec<f32>, JsValue> {
        self.check_node(id)?;
        let &i = self.by_node.get(&id).ok_or_else(|| {
            err(format!("node {id} is not a decision node; it has no strategy"))
        })?;
        Ok(self.sol.nodes[i].strategy.clone())
    }

    /// `player`'s live combos at `id`, in slot order, as a JSON array of
    /// `{index, cards, weight}`.
    ///
    /// `index` is the canonical 1326-combo index (matching [`parse_range`] and
    /// [`combo_labels`]), `cards` is e.g. `"AhKh"`, and `weight` is that combo's reach at
    /// this node: its range weight times this player's own average-strategy probability
    /// for every action taken on the path here. Deal probabilities are excluded, so the
    /// weights stay on the range's own scale — use them for a range grid, and
    /// [`SolutionHandle::combo_ev_weights`] to average EVs.
    pub fn combos(&self, id: u32, player: u8) -> Result<String, JsValue> {
        self.check_node(id)?;
        self.check_player(player)?;
        let weights = self.reach(id, player, false);
        let list: Vec<Value> = self
            .game
            .live_combos(id, player)
            .iter()
            .zip(self.game.combo_indices(id, player))
            .zip(&weights)
            .map(|((&(a, b), &index), &weight)| {
                json!({
                    "index": index,
                    "cards": format!("{}{}", cards::card_to_string(a), cards::card_to_string(b)),
                    "weight": weight,
                })
            })
            .collect();
        Ok(json!(list).to_string())
    }

    /// Per-combo EV in chips for `player` at node `id`, as a `Float32Array` in the same
    /// slot order as [`SolutionHandle::combos`].
    ///
    /// # What the number means
    ///
    /// "What this hand is worth here, in chips, if the hand is played out from this node
    /// with both players following the solved average strategy." It is a **zero-sum** EV:
    /// net chips against the start of the solve, so the two players' range-level figures
    /// sum to 0 (less rake), not to the pot. Add `starting_pot / 2` for the pot-share
    /// convention — see [`SolutionHandle::root_evs`], which reports both.
    ///
    /// # How it is computed
    ///
    /// The opponent's reach vector at `id` is walked down from the root (range weights,
    /// times the opponent's average-strategy probabilities on the path, compacted and
    /// weighted across each chance edge) and handed to `br::subtree_values` with
    /// `maximize = false`. Each combo's raw counterfactual value is then divided by that
    /// combo's **compatible opponent mass** at this node — without it a hand that blocks
    /// most of the opponent's range would look small purely because less mass reaches it.
    ///
    /// That is the whole denominator. The engine's deal weights are conditional
    /// (`1 / (unseen - 4)`, since four of the unseen cards are in the two players' hands),
    /// so every pair carries exactly one unit of runout mass at every chance depth and
    /// there is no residual runout factor left to divide out.
    ///
    /// # Zero mass
    ///
    /// A combo whose compatible opponent mass at this node is 0 — the opponent's range
    /// cannot reach here holding anything this hand does not block — has **no defined
    /// EV**, and its slot is `NaN`. Test with `Number.isNaN` and render it as blank, not
    /// as 0.0: a chip value of zero means break-even, which is a different claim. (The
    /// engine's own `root_combo_evs` returns 0.0 in the same situation; this deliberately
    /// does not.)
    pub fn combo_evs(&self, id: u32, player: u8) -> Result<Vec<f32>, JsValue> {
        self.check_node(id)?;
        self.check_player(player)?;
        let opp_reach = self.reach(id, 1 - player, true);
        let mut values = vec![0.0f32; self.game.live_combos(id, player).len()];
        br::subtree_values(
            &self.game,
            id,
            player,
            &self.profile(),
            &opp_reach,
            false,
            &mut values,
        );
        let mass = self.game.compatible_mass(id, player, &opp_reach);
        for (v, m) in values.iter_mut().zip(&mass) {
            *v = if *m > 0.0 { *v / *m } else { f32::NAN };
        }
        Ok(values)
    }

    /// The weight each entry of [`SolutionHandle::combo_evs`] carries when aggregating,
    /// as a `Float32Array` in the same slot order.
    ///
    /// `sum(weight * ev) / sum(weight)` over the non-`NaN` slots is `player`'s EV in
    /// chips for their whole range at this node, on the zero-sum convention. At the root
    /// that reproduces `root_evs().zero_sum[player]` exactly.
    ///
    /// It is `reach * compatible_mass`: how much of this player's range holds the combo,
    /// times how much of the opponent's range can be there facing it.
    pub fn combo_ev_weights(&self, id: u32, player: u8) -> Result<Vec<f32>, JsValue> {
        self.check_node(id)?;
        self.check_player(player)?;
        let opp_reach = self.reach(id, 1 - player, true);
        let mass = self.game.compatible_mass(id, player, &opp_reach);
        let reach = self.reach(id, player, false);
        Ok(reach.iter().zip(&mass).map(|(r, m)| r * m).collect())
    }

    /// Re-serializes this solution to JSON, for download or for a later
    /// [`load_solution`]. Round-trips exactly: a handle from [`solve_spot`] and the
    /// handle from `load_solution(handle.to_json())` hold identical data.
    pub fn to_json(&self) -> Result<String, JsValue> {
        let mut out = Vec::new();
        self.sol.to_writer(&mut out).map_err(err)?;
        String::from_utf8(out).map_err(|e| err(e.to_string()))
    }
}

/// The stored strategies read back as a fixed profile for the best-response walk.
struct FileProfile<'a> {
    nodes: &'a [NodeStrategy],
    by_node: &'a HashMap<u32, usize>,
}

impl StrategyProfile for FileProfile<'_> {
    fn strategy_into(&self, node: u32, out: &mut [f32]) {
        match self.by_node.get(&node) {
            Some(&i) => out.copy_from_slice(&self.nodes[i].strategy),
            // `SolutionHandle::build` proves this unreachable. Zeroing rather than
            // panicking anyway: a wrong number is recoverable in wasm, a panic is not.
            None => out.fill(0.0),
        }
    }
}

// =====================================================================================
// Action presentation
//
// `percent_of_pot` and the label text mirror `cli/src/show.rs`, which is a binary crate
// this cannot depend on. Keep the two in step.
// =====================================================================================

fn action_json(
    tree: &GameTree,
    node: u32,
    player: u8,
    actions: &[Action],
    action: &Action,
) -> Value {
    json!({
        "label": match action.label {
            ActionLabel::Fold => "fold",
            ActionLabel::Check => "check",
            ActionLabel::Call => "call",
            ActionLabel::Bet(_) => "bet",
            ActionLabel::Raise(_) => "raise",
            ActionLabel::AllIn => "allin",
        },
        "text": label_text(action.label),
        "amount_to": match action.label {
            ActionLabel::Bet(x) | ActionLabel::Raise(x) => Some(x),
            _ => None,
        },
        "percent_of_pot": action_percent(tree, node, player, actions, action),
        "child": action.child,
    })
}

fn label_text(label: ActionLabel) -> String {
    match label {
        ActionLabel::Fold => "fold".to_string(),
        ActionLabel::Check => "check".to_string(),
        ActionLabel::Call => "call".to_string(),
        ActionLabel::AllIn => "all-in".to_string(),
        ActionLabel::Bet(x) => format!("bet to {x:.2}"),
        ActionLabel::Raise(x) => format!("raise to {x:.2}"),
    }
}

/// Percent-of-pot for a bet or raise, computed the way the config's sizing tables define
/// it: a bet against the pot at this node, a raise against the pot as it would be after
/// calling. `None` for fold/check/call/all-in.
fn action_percent(
    tree: &GameTree,
    node: u32,
    player: u8,
    actions: &[Action],
    action: &Action,
) -> Option<f64> {
    let n = tree.node(node);
    match action.label {
        ActionLabel::Bet(amount) => Some(100.0 * amount / n.pot),
        ActionLabel::Raise(_) => {
            let call = actions.iter().find(|a| matches!(a.label, ActionLabel::Call))?;
            let post_call_pot = tree.node(call.child).pot;
            let to_call = post_call_pot - n.pot;
            let added = n.stacks[player as usize] - tree.node(action.child).stacks[player as usize];
            Some(100.0 * (added - to_call) / post_call_pot)
        }
        _ => None,
    }
}
