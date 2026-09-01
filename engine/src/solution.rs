//! The solution file format — the persisted output of one solve.
//!
//! Designed as the product contract: this is what a future WASM/web UI reads, so it
//! carries everything a reader needs *without* re-solving or re-parsing ranges —
//! the config, solve metadata, every decision node's average strategy, and both
//! players' root combo lists (so slot `i` of a root strategy array can be labeled
//! without touching the `range` module at all).
//!
//! # What is *not* stored, and why
//!
//! The tree itself. [`crate::tree::GameTree::build`] is a pure function of
//! [`SolveConfig`] and the board, so [`Solution::load`] rebuilds it and checks the
//! result still matches what this file was solved on — total node count, and for
//! every stored decision node, its acting player and action count — failing loudly
//! on any mismatch rather than silently loading strategies against the wrong tree.
//! Per-node live combo lists are not stored either, for the same reason: they are a
//! deterministic function of (config, node's board), which the `nlhe` module already
//! knows how to compute.
//!
//! # Layout
//!
//! Per decision node: a flat `f32` array, action-major
//! (`strategy[a * combo_count + i]`), exactly the layout
//! [`crate::cfr::Solver::average_strategy`] returns, so `from_solver` is a direct
//! copy with no repacking.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cards;
use crate::cfr::Solver;
use crate::config::SolveConfig;
use crate::game::Game;
use crate::nlhe::NlheGame;
use crate::tree::{ActionLabel, GameTree, NodeKind};

/// Current file format version. Bump when the layout changes incompatibly.
///
/// [`Solution::load`] refuses a file whose `format_version` is *greater* than this
/// (a future format this build doesn't understand yet); it does not attempt to
/// migrate an older one.
pub const FORMAT_VERSION: u32 = 1;

/// One player's root combo: enough to label a strategy slot without rebuilding a
/// [`crate::range::Range`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RootCombo {
    /// Canonical 1326-combo index (see [`crate::range::combo_index`]).
    pub index: u32,
    /// Card string, e.g. `"AhKh"`.
    pub cards: String,
}

/// A serializable mirror of [`ActionLabel`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "amount")]
pub enum ActionLabelData {
    Fold,
    Check,
    Call,
    /// Street total after betting. See [`ActionLabel::Bet`].
    Bet(f64),
    /// Street total after raising. See [`ActionLabel::Raise`].
    Raise(f64),
    AllIn,
}

impl From<ActionLabel> for ActionLabelData {
    fn from(label: ActionLabel) -> Self {
        match label {
            ActionLabel::Fold => ActionLabelData::Fold,
            ActionLabel::Check => ActionLabelData::Check,
            ActionLabel::Call => ActionLabelData::Call,
            ActionLabel::Bet(x) => ActionLabelData::Bet(x),
            ActionLabel::Raise(x) => ActionLabelData::Raise(x),
            ActionLabel::AllIn => ActionLabelData::AllIn,
        }
    }
}

/// One decision node's solved average strategy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeStrategy {
    /// Index of this node in the tree rebuilt from [`Solution::config`].
    pub node: u32,
    /// Acting player: 0 = OOP, 1 = IP.
    pub player: u8,
    /// One label per action, action-major axis of `strategy`, in tree order.
    pub actions: Vec<ActionLabelData>,
    /// Live combo count for `player` at this node — the other axis of `strategy`.
    pub combo_count: u32,
    /// Average strategy, action-major: `strategy[a * combo_count + i]`.
    pub strategy: Vec<f32>,
}

/// Root EVs in both display conventions, indexed `[OOP, IP]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RootEvs {
    /// Net chips vs. the start of the solve (see the `nlhe` module docs).
    pub zero_sum: [f32; 2],
    /// PioSOLVER-style pot-inclusive figure ([`NlheGame::ev_pot_share`]).
    pub pot_share: [f32; 2],
}

/// Everything about how a solution was reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolveMeta {
    pub iterations: u64,
    pub exploitability_chips: f32,
    pub exploitability_pct_of_pot: f32,
    pub root_evs: RootEvs,
    pub wall_seconds: f64,
    /// `CARGO_PKG_VERSION` of the engine that produced this file.
    pub engine_version: String,
}

/// A solved spot, self-describing enough to reload and inspect without re-solving.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Solution {
    pub format_version: u32,
    pub config: SolveConfig,
    pub meta: SolveMeta,
    /// Total node count of the tree this was solved on; the first structure guard
    /// [`Solution::load`] checks after rebuilding from `config`.
    pub node_count: u32,
    /// One entry per decision node, in tree order.
    pub nodes: Vec<NodeStrategy>,
    /// Root combo lists, `[OOP, IP]`, in the same slot order as the root node's
    /// strategy arrays.
    pub root_combos: [Vec<RootCombo>; 2],
}

impl Solution {
    /// Builds a [`Solution`] from a solved [`Solver`], capturing every decision
    /// node's current average strategy.
    pub fn from_solver(solver: &Solver<NlheGame>, wall_seconds: f64) -> Solution {
        let game = solver.game();
        let tree = game.tree();

        let root_ev_zero_sum = [solver.expected_value(0), solver.expected_value(1)];
        let root_ev_pot_share = [
            game.ev_pot_share(0, root_ev_zero_sum[0]),
            game.ev_pot_share(1, root_ev_zero_sum[1]),
        ];
        let report = solver.exploitability();

        let mut nodes = Vec::new();
        for idx in 0..tree.len() as u32 {
            if let NodeKind::Decision { player, actions } = &tree.node(idx).kind {
                nodes.push(NodeStrategy {
                    node: idx,
                    player: *player,
                    actions: actions.iter().map(|a| a.label.into()).collect(),
                    combo_count: game.live_combos(idx, *player).len() as u32,
                    strategy: solver.average_strategy(idx),
                });
            }
        }

        let root = game.root();
        let root_combos = std::array::from_fn(|p| {
            let p = p as u8;
            game.live_combos(root, p)
                .iter()
                .zip(game.combo_indices(root, p))
                .map(|(&(a, b), &index)| RootCombo {
                    index,
                    cards: format!("{}{}", cards::card_to_string(a), cards::card_to_string(b)),
                })
                .collect()
        });

        Solution {
            format_version: FORMAT_VERSION,
            config: game.config().clone(),
            meta: SolveMeta {
                iterations: solver.iterations(),
                exploitability_chips: report.chips,
                exploitability_pct_of_pot: report.pct_of_pot,
                root_evs: RootEvs { zero_sum: root_ev_zero_sum, pot_share: root_ev_pot_share },
                wall_seconds,
                engine_version: env!("CARGO_PKG_VERSION").to_string(),
            },
            node_count: tree.len() as u32,
            nodes,
            root_combos,
        }
    }

    /// Streams this solution to `path` as JSON. Files can run tens of MB, so this
    /// goes through a [`BufWriter`] rather than building the whole document in RAM.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), String> {
        let path = path.as_ref();
        let file = File::create(path).map_err(|e| format!("cannot create {path:?}: {e}"))?;
        self.to_writer(BufWriter::new(file))
    }

    /// Same as [`Solution::save`] but to any writer, for reuse by non-file callers
    /// (e.g. a future WASM build writing into memory).
    pub fn to_writer<W: Write>(&self, writer: W) -> Result<(), String> {
        serde_json::to_writer(writer, self).map_err(|e| format!("cannot write solution: {e}"))
    }

    /// Streams a solution back from `path` and validates it against a freshly
    /// rebuilt tree. See the module docs for exactly what is checked.
    pub fn load(path: impl AsRef<Path>) -> Result<Solution, String> {
        let path = path.as_ref();
        let file = File::open(path).map_err(|e| format!("cannot open {path:?}: {e}"))?;
        Self::from_reader(BufReader::new(file))
    }

    /// Same as [`Solution::load`] but from any reader.
    pub fn from_reader<R: Read>(reader: R) -> Result<Solution, String> {
        let sol: Solution =
            serde_json::from_reader(reader).map_err(|e| format!("cannot parse solution: {e}"))?;
        if sol.format_version > FORMAT_VERSION {
            return Err(format!(
                "solution file format_version {} is newer than format_version {} this build \
                 supports; rebuild with a matching engine version",
                sol.format_version, FORMAT_VERSION
            ));
        }
        sol.validate_structure()?;
        Ok(sol)
    }

    /// Rebuilds the tree from `config` (structure only — [`GameTree::build`], no
    /// CFR run) and checks it against what this file claims: total node count, and
    /// per stored decision node its acting player, action count, and strategy array
    /// length. Fails loudly rather than loading strategies against a tree that no
    /// longer matches.
    fn validate_structure(&self) -> Result<(), String> {
        let board = self
            .config
            .board_cards()
            .map_err(|e| format!("solution config: {e}"))?;
        let tree = GameTree::build(&self.config, &board)
            .map_err(|e| format!("solution config does not build a tree: {e}"))?;

        if tree.len() as u32 != self.node_count {
            return Err(format!(
                "structure guard failed: solution claims {} nodes, rebuilt tree has {}",
                self.node_count,
                tree.len()
            ));
        }

        for ns in &self.nodes {
            if ns.node >= self.node_count {
                return Err(format!(
                    "structure guard failed: node {} is out of range ({} nodes)",
                    ns.node, self.node_count
                ));
            }
            match &tree.node(ns.node).kind {
                NodeKind::Decision { player, actions } => {
                    if *player != ns.player {
                        return Err(format!(
                            "structure guard failed: node {} acting player mismatch \
                             (file says {}, rebuilt tree has {})",
                            ns.node, ns.player, player
                        ));
                    }
                    if actions.len() != ns.actions.len() {
                        return Err(format!(
                            "structure guard failed: node {} action count mismatch \
                             (file says {}, rebuilt tree has {})",
                            ns.node,
                            ns.actions.len(),
                            actions.len()
                        ));
                    }
                }
                other => {
                    return Err(format!(
                        "structure guard failed: node {} is a decision node in the file \
                         but {other:?} in the rebuilt tree",
                        ns.node
                    ));
                }
            }
            let expected = ns.actions.len() * ns.combo_count as usize;
            if ns.strategy.len() != expected {
                return Err(format!(
                    "structure guard failed: node {} strategy length {} does not match \
                     actions({}) * combo_count({}) = {expected}",
                    ns.node,
                    ns.strategy.len(),
                    ns.actions.len(),
                    ns.combo_count
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cfr::DcfrParams;
    use crate::config::Sizings;

    // Same tiny river spot as `nlhe`'s milestone-3 test: 3 decision nodes, hand
    // solvable, and (per the ground truth measured on this machine) fast — 20k
    // iterations run in tens of milliseconds, so the round trip stays a cheap test.
    fn small_cfg() -> SolveConfig {
        let mut cfg = SolveConfig {
            board: "Ks 7d 2c 8h 3d".to_string(),
            oop_range: "KK,A4s,A5s".to_string(),
            ip_range: "TT,JJ".to_string(),
            effective_stack: 10.0,
            starting_pot: 10.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        cfg.sizings.oop.river.bet = Sizings::new(&[100.0], false);
        cfg.sizings.ip.river.bet = Sizings::new(&[100.0], false);
        cfg
    }

    fn solved() -> Solver<NlheGame> {
        let game = NlheGame::new(&small_cfg()).expect("game builds");
        let mut s = Solver::new(game);
        s.run(500, &DcfrParams::default(), 0, |_, _, _| {});
        s
    }

    #[test]
    fn round_trip_is_bit_identical() {
        let solver = solved();
        let sol = Solution::from_solver(&solver, 0.0123);
        assert_eq!(sol.format_version, FORMAT_VERSION);
        assert!(!sol.nodes.is_empty());

        let dir = std::env::temp_dir();
        let path = dir.join(format!("solution_roundtrip_{}.json", std::process::id()));
        sol.save(&path).expect("save");
        let loaded = Solution::load(&path).expect("load");
        std::fs::remove_file(&path).ok();

        assert_eq!(loaded, sol, "loaded solution must be bit-identical to the saved one");
        // Spot-check against the live solver directly, not just self-consistency.
        for ns in &sol.nodes {
            assert_eq!(ns.strategy, solver.average_strategy(ns.node));
        }
        assert_eq!(sol.meta.iterations, solver.iterations());
    }

    #[test]
    fn tampered_action_count_fails_to_load() {
        let solver = solved();
        let mut sol = Solution::from_solver(&solver, 0.0);

        // Tamper: drop one action label from a decision node without touching its
        // strategy array, so the guard's very first check (action count vs. the
        // rebuilt tree) is what fires.
        let ns = sol
            .nodes
            .iter_mut()
            .find(|n| n.actions.len() >= 2)
            .expect("at least one multi-action decision node");
        ns.actions.pop();

        let dir = std::env::temp_dir();
        let path = dir.join(format!("solution_tampered_{}.json", std::process::id()));
        sol.save(&path).expect("save");
        let err = Solution::load(&path).expect_err("tampered file must fail to load");
        std::fs::remove_file(&path).ok();

        assert!(err.contains("action count mismatch"), "unexpected error: {err}");
    }

    #[test]
    fn future_format_version_fails_to_load() {
        let solver = solved();
        let mut sol = Solution::from_solver(&solver, 0.0);
        sol.format_version = 999;

        let dir = std::env::temp_dir();
        let path = dir.join(format!("solution_future_version_{}.json", std::process::id()));
        sol.save(&path).expect("save");
        let err = Solution::load(&path).expect_err("a file from a newer format must not load silently");
        std::fs::remove_file(&path).ok();

        assert!(err.contains("999"), "unexpected error: {err}");
        assert!(err.contains(&FORMAT_VERSION.to_string()), "unexpected error: {err}");
    }
}
