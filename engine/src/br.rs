//! Full best-response calculator and the exploitability measure.
//!
//! Deliberately separate from the CFR traversal: this walks the tree against a *fixed*
//! strategy profile and takes a per-combo maximum at the best-responder's nodes, so it
//! is an independent check on the solver rather than a byproduct of it.
//!
//! # Exploitability
//!
//! With the net-chips zero-sum convention from [`crate::game`], a player's
//! best-response value against an equilibrium is exactly the game value for that player,
//! and the two game values sum to zero. So
//!
//! ```text
//! exploitability = BR_value(player 0) + BR_value(player 1)
//! ```
//!
//! is non-negative, and is **0 exactly at Nash**. Each term on its own is that player's
//! best-response value, not their gain, but the sum is the total gain because the two
//! equilibrium values cancel. Reported in chips and as a percentage of
//! [`crate::game::Game::root_pot`], the pot a human would quote the number against.
//!
//! Values are divided by [`crate::game::Game::normalizer`] to come out as chips per
//! hand rather than chips times total joint range mass.
//!
//! In a raked game the two terminal utilities sum to minus the rake instead of zero, so
//! the sum is offset by the expected rake and no longer bottoms out at 0. Compare it
//! against the raked game's own floor, or solve rake-free to check convergence.

use crate::cfr::{read_write, Scratch};
use crate::game::{Game, NodeInfo};

/// Read access to one fixed strategy profile — typically a solver's average strategy.
pub trait StrategyProfile {
    /// Writes the acting player's action probabilities at decision node `node` into
    /// `out`, action-major (`out[a * combo_count + i]`), length
    /// `num_actions * combo_count(node, acting_player)`. Each combo's entries must sum
    /// to 1.
    fn strategy_into(&self, node: u32, out: &mut [f32]);
}

/// A uniform-random profile, useful as a sanity baseline.
pub struct UniformProfile<'a, G: Game>(pub &'a G);

impl<G: Game> StrategyProfile for UniformProfile<'_, G> {
    fn strategy_into(&self, node: u32, out: &mut [f32]) {
        let NodeInfo::Decision { num_actions, .. } = self.0.node(node) else {
            panic!("strategy_into on a non-decision node {node}");
        };
        out.fill(1.0 / num_actions as f32);
    }
}

/// Result of an exploitability measurement, all figures in chips per hand.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExploitReport {
    /// Best-response value for each player against the profile: `[player 0, player 1]`.
    pub br: [f32; 2],
    /// `br[0] + br[1]` — the total exploitability. Zero at an exact equilibrium.
    pub chips: f32,
    /// `chips` as a percentage of the root pot.
    pub pct_of_pot: f32,
}

/// Value to `hero` of best-responding to `profile`, in chips per hand.
pub fn best_response_value<G: Game, P: StrategyProfile>(game: &G, hero: u8, profile: &P) -> f32 {
    root_value(game, hero, profile, true)
}

/// Value to `hero` when both players follow `profile`, in chips per hand.
pub fn expected_value<G: Game, P: StrategyProfile>(game: &G, hero: u8, profile: &P) -> f32 {
    root_value(game, hero, profile, false)
}

/// Best-response values for both players plus the exploitability of `profile`.
pub fn exploitability<G: Game, P: StrategyProfile>(game: &G, profile: &P) -> ExploitReport {
    let br = [
        best_response_value(game, 0, profile),
        best_response_value(game, 1, profile),
    ];
    let chips = br[0] + br[1];
    ExploitReport { br, chips, pct_of_pot: 100.0 * chips / game.root_pot() }
}

fn root_value<G: Game, P: StrategyProfile>(game: &G, hero: u8, profile: &P, maximize: bool) -> f32 {
    let root = game.root();
    let opp = 1 - hero;
    let hn = game.combo_count(root, hero);
    let on = game.combo_count(root, opp);

    let mut br = Br { game, profile, scratch: Scratch::new(), maximize };
    let o_off = br.scratch.alloc(on);
    let out = br.scratch.alloc(hn);
    br.scratch.buf[o_off..o_off + on].copy_from_slice(game.root_weights(opp));
    br.walk(root, hero, o_off, on, out, hn);

    let mut total = 0.0f32;
    for (i, &wi) in game.root_weights(hero).iter().take(hn).enumerate() {
        total += wi * br.scratch.buf[out + i];
    }
    total / game.normalizer()
}

struct Br<'a, G: Game, P: StrategyProfile> {
    game: &'a G,
    profile: &'a P,
    scratch: Scratch,
    maximize: bool,
}

impl<G: Game, P: StrategyProfile> Br<'_, G, P> {
    /// Writes hero's counterfactual value vector for the subtree at `node` into
    /// `scratch[out .. out + hn]`. Hero's own reach is never needed: at hero's nodes we
    /// either maximize per combo or weight by hero's own strategy.
    fn walk(&mut self, node: u32, hero: u8, o_off: usize, on: usize, out: usize, hn: usize) {
        let g = self.game;
        match g.node(node) {
            NodeInfo::Terminal => {
                let (r, w) = read_write(&mut self.scratch.buf, o_off, on, out, hn);
                g.terminal_utility(node, hero, r, w);
            }
            NodeInfo::Chance { num_outcomes } => {
                self.scratch.zero(out, hn);
                for k in 0..num_outcomes {
                    let edge = g.chance_outcome(node, k);
                    let map_h = edge.parent_of_child[hero as usize];
                    let map_o = edge.parent_of_child[(1 - hero) as usize];
                    let (chn, con) = (map_h.len(), map_o.len());
                    let save = self.scratch.top;
                    let co = self.scratch.alloc(con);
                    let cout = self.scratch.alloc(chn);
                    for (t, &p) in map_o.iter().enumerate() {
                        self.scratch.buf[co + t] =
                            self.scratch.buf[o_off + p as usize] * edge.weight;
                    }
                    self.walk(edge.child, hero, co, con, cout, chn);
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[out + p as usize] += self.scratch.buf[cout + t];
                    }
                    self.scratch.top = save;
                }
            }
            NodeInfo::Decision { player, num_actions } if player == hero => {
                let size = num_actions * hn;
                let base = self.scratch.top;
                let evs = self.scratch.alloc(size);
                for a in 0..num_actions {
                    let save = self.scratch.top;
                    self.walk(g.child(node, a), hero, o_off, on, evs + a * hn, hn);
                    self.scratch.top = save;
                }
                if self.maximize {
                    for i in 0..hn {
                        let mut best = self.scratch.buf[evs + i];
                        for a in 1..num_actions {
                            let v = self.scratch.buf[evs + a * hn + i];
                            if v > best {
                                best = v;
                            }
                        }
                        self.scratch.buf[out + i] = best;
                    }
                } else {
                    let sig = self.scratch.alloc(size);
                    self.profile
                        .strategy_into(node, &mut self.scratch.buf[sig..sig + size]);
                    self.scratch.zero(out, hn);
                    for a in 0..num_actions {
                        for i in 0..hn {
                            let v = self.scratch.buf[sig + a * hn + i]
                                * self.scratch.buf[evs + a * hn + i];
                            self.scratch.buf[out + i] += v;
                        }
                    }
                }
                self.scratch.top = base;
            }
            NodeInfo::Decision { num_actions, .. } => {
                let size = num_actions * on;
                let base = self.scratch.top;
                let sig = self.scratch.alloc(size);
                self.profile
                    .strategy_into(node, &mut self.scratch.buf[sig..sig + size]);
                self.scratch.zero(out, hn);
                for a in 0..num_actions {
                    let save = self.scratch.top;
                    let co = self.scratch.alloc(on);
                    let tmp = self.scratch.alloc(hn);
                    for i in 0..on {
                        self.scratch.buf[co + i] =
                            self.scratch.buf[o_off + i] * self.scratch.buf[sig + a * on + i];
                    }
                    self.walk(g.child(node, a), hero, co, on, tmp, hn);
                    for i in 0..hn {
                        self.scratch.buf[out + i] += self.scratch.buf[tmp + i];
                    }
                    self.scratch.top = save;
                }
                self.scratch.top = base;
            }
        }
    }
}
