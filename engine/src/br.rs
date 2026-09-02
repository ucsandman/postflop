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
//!
//! # NashConv, when the game is general-sum
//!
//! Under a tournament (ICM) payoff map the two utilities sum to a number that varies
//! from terminal to terminal rather than a constant one, and whose sign is not fixed
//! either -- equity leaks to the frozen field when the hand pushes the two stacks
//! apart and drains from it when the hand pulls them together
//! ([`crate::game::Game::zero_sum`] returns `false`). So `BR_0 + BR_1` is not an
//! exploitability, not an upper bound, and not offset by anything you can subtract. What is still well defined is each player's **unilateral
//! gain**
//!
//! ```text
//! gain_i = BR_value(i) - EV(i)
//! ```
//!
//! That is how much player `i` picks up by deviating alone while the opponent keeps
//! playing the profile. [`ExploitReport::gain`] holds the pair and [`ExploitReport::chips`]
//! their sum, **NashConv**. In a zero-sum game `EV_0 + EV_1 == 0`, so NashConv is
//! numerically the figure this module has always reported: `gain` is then exactly `br`,
//! and the chip path takes that branch without the two extra walks, bit for bit.
//!
//! What NashConv certifies, and what it does not. It measures one profile: at zero,
//! neither player can improve unilaterally, which is a Nash equilibrium of the
//! general-sum game. It is **not** a guaranteed minimum EV - a general-sum equilibrium
//! has no value in the minimax sense, the equilibrium need not be unique, and two
//! equilibria of the same spot can pay differently. Two consequences that get reported
//! as bugs and are not: adding a bet size can lower *both* players' EV, and playing the
//! equilibrium against an opponent's mistake can lose you equity.
//!
//! # Exploitability under a node lock
//!
//! A locked node ([`crate::game::Game::locked_strategy`]) is not a decision the best
//! responder gets to make: the walk follows the frozen distribution there instead of
//! taking the per-combo maximum. So with locks in play the number above is
//! exploitability **of and against the locked profile**:
//!
//! * The unlocked player best-responds normally, over the whole tree.
//! * The locked player best-responds only where it is still free; at a locked node it
//!   must keep playing the frozen distribution.
//!
//! The locked game is still zero-sum and still has a value, so the sum is still
//! non-negative and still reaches **0 exactly at an equilibrium of the constrained
//! game** — which is the thing the solver is now solving for. It is *not* comparable
//! with the unlocked spot's exploitability: a profile that is unexploitable given the
//! lock is generally very exploitable without it, and that gap is the cost of the lock,
//! not a convergence failure.

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
    /// Each player's unilateral gain, `br[i] - EV(i)`: what they win by deviating on
    /// their own. In a zero-sum game the two equilibrium values cancel in the sum, so
    /// this is exactly `br` and is produced without the extra walks.
    pub gain: [f32; 2],
    /// `gain[0] + gain[1]`. The total exploitability in a zero-sum game (where it also
    /// equals `br[0] + br[1]`); **NashConv** in a general-sum one. Zero at equilibrium.
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
    // Zero-sum: `EV_0 + EV_1 == 0`, so `gain[0] + gain[1] == br[0] + br[1]` exactly and
    // the two expected-value walks would only recompute a cancelling pair. Taking this
    // branch is what keeps every chip solve bit-identical to before `gain` existed.
    let gain = if game.zero_sum() {
        br
    } else {
        [
            br[0] - expected_value(game, 0, profile),
            br[1] - expected_value(game, 1, profile),
        ]
    };
    debug_assert!(
        gain[0] >= -1e-3 && gain[1] >= -1e-3,
        "a unilateral best response cannot lose to the profile it deviates from: gain {gain:?}"
    );
    let chips = gain[0] + gain[1];
    ExploitReport { br, gain, chips, pct_of_pot: 100.0 * chips / game.root_pot() }
}

/// Hero's per-combo counterfactual value vector for the subtree rooted at `node`.
///
/// `opp_reach` is the opponent's reach vector *at `node`* (range weights times every
/// opponent action probability and chance weight on the path to it), length
/// `combo_count(node, 1 - hero)`; `out` has `combo_count(node, hero)` entries and is
/// overwritten. `maximize` picks between best-responding at hero's nodes and following
/// `profile` there.
///
/// Values are raw counterfactual chips — not divided by [`Game::normalizer`] and not by
/// the opponent mass compatible with each hero combo. Divide by the latter to get a
/// per-combo EV, or dot with hero's own reach and divide by the normalizer to get a
/// scalar in chips per hand (which is what [`expected_value`] does).
pub fn subtree_values<G: Game, P: StrategyProfile>(
    game: &G,
    node: u32,
    hero: u8,
    profile: &P,
    opp_reach: &[f32],
    maximize: bool,
    out: &mut [f32],
) {
    debug_assert_eq!(opp_reach.len(), game.combo_count(node, 1 - hero));
    debug_assert_eq!(out.len(), game.combo_count(node, hero));
    let (on, hn) = (opp_reach.len(), out.len());

    let mut br = Br { game, profile, scratch: Scratch::new(), maximize };
    let o_off = br.scratch.alloc(on);
    let v_off = br.scratch.alloc(hn);
    br.scratch.buf[o_off..o_off + on].copy_from_slice(opp_reach);
    br.walk(node, hero, o_off, on, v_off, hn);
    out.copy_from_slice(&br.scratch.buf[v_off..v_off + hn]);
}

fn root_value<G: Game, P: StrategyProfile>(game: &G, hero: u8, profile: &P, maximize: bool) -> f32 {
    let root = game.root();
    let hn = game.combo_count(root, hero);
    let mut values = vec![0.0f32; hn];
    subtree_values(
        game,
        root,
        hero,
        profile,
        game.root_weights(1 - hero),
        maximize,
        &mut values,
    );

    let mut total = 0.0f32;
    for (i, &wi) in game.root_weights(hero).iter().take(hn).enumerate() {
        total += wi * values[i];
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
    /// Fills `scratch[sig .. sig + size]` with the acting player's strategy at `node`:
    /// the lock when the node is locked, `profile`'s answer otherwise.
    ///
    /// The lock wins over the profile because it belongs to the *game*, not the profile —
    /// so `exploitability` is well defined for any profile handed in, including one that
    /// knows nothing about locking.
    fn fill_strategy(&mut self, lock: Option<&[f32]>, node: u32, sig: usize, size: usize) {
        let dst = &mut self.scratch.buf[sig..sig + size];
        match lock {
            Some(lock) => {
                assert!(
                    lock.len() == size,
                    "node {node}: locked strategy has {} entries, expected {size} — see \
                     Game::locked_strategy",
                    lock.len()
                );
                dst.copy_from_slice(lock);
            }
            None => self.profile.strategy_into(node, dst),
        }
    }

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
                // A locked node is not hero's to choose at, even when best-responding —
                // see `Game::locked_strategy` for what that makes exploitability mean.
                let lock = g.locked_strategy(node);
                if self.maximize && lock.is_none() {
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
                    self.fill_strategy(lock, node, sig, size);
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
                self.fill_strategy(g.locked_strategy(node), node, sig, size);
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
