//! Vector-form Discounted CFR (Brown & Sandholm, AAAI 2019) with alternating updates.
//!
//! Full traversal of every live combo on every iteration — no external sampling, no
//! outcome sampling, no abstraction. One iteration walks the tree twice: once updating
//! player 0's regrets and strategy sums against player 1's current strategy, then once
//! the other way round.
//!
//! Storage is two flat `f32` arrays (cumulative regret, cumulative strategy) with one
//! precomputed offset per decision node and `num_actions * combo_count` entries each,
//! laid out action-major (`[a * combos + i]`). Working vectors come from a bump arena
//! that stops growing after the first iteration, so the steady-state traversal does not
//! allocate.
//!
//! Convergence is measured by exploitability from [`crate::br`], never by regret
//! magnitude.
//!
//! # Parallelism (rayon), and why it is bit-deterministic
//!
//! The traversal forks at **chance nodes** — the 49 turn cards, the 48 river cards —
//! and only at the *outermost* one on any path ([`PAR_MIN_OUTCOMES`] outcomes or more),
//! which on a flop tree is a turn node with 49 fat, well-balanced subtrees. Inner
//! per-combo loops stay flat sequential `f32` loops so they keep vectorizing; nothing
//! below the fork is parallel.
//!
//! Two properties make the result **bit-identical to the sequential walk**, and hence
//! identical for any thread count:
//!
//! 1. **Parallel map, sequential reduce.** Each outcome writes its counterfactual value
//!    vector into its own buffer. The expansion back into the parent's slots
//!    (`out[parent_of_child[k]] += child[k]`) then runs on the main thread in ascending
//!    outcome order — exactly the order the sequential loop used. Float addition is not
//!    associative, so this fixed order is the whole game.
//! 2. **Disjoint storage writes.** See [`Store`]. No atomics, no locks, no reduction
//!    over regrets.
//!
//! The best-response walk in [`crate::br`] is still sequential; with a coarse
//! `report_every` it is a small share of a solve.

use std::slice;

use rayon::prelude::*;

use crate::br::{self, ExploitReport, StrategyProfile};
use crate::config::SolveConfig;
use crate::game::{Game, NodeInfo};

/// Fork a chance node across threads only when it has at least this many outcomes.
///
/// Real runouts have 48 or 49; toy games (and any future 2- or 3-way chance node) stay
/// on the sequential path, where rayon's fork overhead would swamp the subtree.
pub const PAR_MIN_OUTCOMES: usize = 8;

/// Discounting schedule. Defaults are the DCFR paper's recommended `1.5 / 0 / 2`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DcfrParams {
    /// Exponent on the discount applied to **positive** cumulative regret.
    pub alpha: f64,
    /// Exponent on the discount applied to **negative** cumulative regret.
    pub beta: f64,
    /// Exponent on the discount applied to the cumulative strategy.
    pub gamma: f64,
    /// CFR+/DCFR+ style flag: clamp cumulative regret at zero right after each update,
    /// so a negative regret never has to be climbed back out of. Off by default.
    pub floor_regrets_at_zero: bool,
}

impl Default for DcfrParams {
    fn default() -> Self {
        DcfrParams { alpha: 1.5, beta: 0.0, gamma: 2.0, floor_regrets_at_zero: false }
    }
}

impl DcfrParams {
    /// Reads `alpha`/`beta`/`gamma` off a [`SolveConfig`]. The regret floor is not a
    /// config field and stays off.
    pub fn from_config(cfg: &SolveConfig) -> Self {
        DcfrParams {
            alpha: cfg.alpha,
            beta: cfg.beta,
            gamma: cfg.gamma,
            floor_regrets_at_zero: false,
        }
    }
}

/// Bump arena of `f32` working vectors, indexed rather than borrowed so that a
/// recursive traversal can hold several regions at once without fighting the borrow
/// checker. `top` is saved and restored around each recursive call.
pub(crate) struct Scratch {
    pub buf: Vec<f32>,
    pub top: usize,
}

impl Scratch {
    pub(crate) fn new() -> Self {
        Scratch { buf: Vec::new(), top: 0 }
    }

    /// Reserves `n` slots and returns their base index. Contents are unspecified.
    /// Only grows the backing `Vec` on the first traversal that reaches a given depth.
    #[inline]
    pub(crate) fn alloc(&mut self, n: usize) -> usize {
        let base = self.top;
        self.top += n;
        if self.buf.len() < self.top {
            self.buf.resize(self.top, 0.0);
        }
        base
    }

    #[inline]
    pub(crate) fn zero(&mut self, base: usize, n: usize) {
        self.buf[base..base + n].fill(0.0);
    }
}

/// Splits one arena into a disjoint read slice and write slice. Panics if the ranges
/// overlap.
pub(crate) fn read_write(
    buf: &mut [f32],
    r: usize,
    rn: usize,
    w: usize,
    wn: usize,
) -> (&[f32], &mut [f32]) {
    if r + rn <= w {
        let (lo, hi) = buf.split_at_mut(w);
        let lo: &[f32] = lo;
        (&lo[r..r + rn], &mut hi[..wn])
    } else {
        assert!(w + wn <= r, "read and write regions overlap");
        let (lo, hi) = buf.split_at_mut(r);
        let hi: &[f32] = hi;
        (&hi[..rn], &mut lo[w..w + wn])
    }
}

/// Shared handle on the solver's two per-node storage arrays, handed by value to
/// parallel subtree tasks.
///
/// # Why raw pointers, and why this is sound
///
/// A `&mut [f32]` cannot be split across chance outcomes with `split_at_mut` — the
/// regions a subtree touches are scattered by node id, not contiguous — and a
/// `Mutex`/`RefCell` per node in the hot path would cost more than the parallelism buys.
/// So the two arrays travel as raw pointers and every access materializes a `&mut [f32]`
/// covering **one decision node's region only** (`offsets[node] .. + sizes[node]`).
///
/// Those per-node regions never alias across concurrent tasks:
///
/// * The solver lays storage out with one disjoint `[off, off + size)` block per
///   decision node (see [`Solver::new`]), so two distinct nodes never share a slot.
/// * Tasks are forked one per outcome of a single chance node, and the tree builds a
///   **distinct subtree per chance outcome** — no node is reachable from two outcomes of
///   the same chance node. So task `k` writes only nodes in subtree `k`, and the subtrees
///   are node-disjoint.
/// * Alternating updates mean a half-iteration writes only the *traversing* player's
///   nodes, which shrinks the write set further but is not needed for the argument.
/// * The parent's own frames (`self.scratch`, the reduction buffer) are never handed to a
///   task; each task allocates its own [`Scratch`].
///
/// Hence at most one live `&mut` exists for any byte at any time, which is what the
/// aliasing rules actually require. Widening the fork beyond one chance node's outcomes
/// — e.g. forking two chance nodes at once, or reusing a `Store` across a decision edge
/// — would break the second bullet and is not done anywhere.
#[derive(Clone, Copy)]
pub(crate) struct Store {
    regrets: *mut f32,
    strat: *mut f32,
    len: usize,
}

// SAFETY: `Store` is only ever shared under the disjointness argument documented above.
unsafe impl Send for Store {}
unsafe impl Sync for Store {}

impl Store {
    fn new(regrets: &mut [f32], strat: &mut [f32]) -> Store {
        debug_assert_eq!(regrets.len(), strat.len());
        Store { regrets: regrets.as_mut_ptr(), strat: strat.as_mut_ptr(), len: regrets.len() }
    }

    /// Cumulative regret for one node's region.
    ///
    /// # Safety
    /// `off..off + n` must be that node's own region, and no other live reference may
    /// cover it. See the type docs for why concurrent tasks satisfy this.
    #[inline]
    unsafe fn regrets(&self, off: usize, n: usize) -> &'static mut [f32] {
        debug_assert!(off + n <= self.len);
        slice::from_raw_parts_mut(self.regrets.add(off), n)
    }

    /// Cumulative strategy for one node's region. Same safety contract as
    /// [`Store::regrets`].
    #[inline]
    unsafe fn strat(&self, off: usize, n: usize) -> &'static mut [f32] {
        debug_assert!(off + n <= self.len);
        slice::from_raw_parts_mut(self.strat.add(off), n)
    }
}

/// Fills `out` (action-major, `n_act * n_combo`) with regret matching over `regrets`:
/// `sigma(a) ∝ max(R(a), 0)`, uniform when no action has positive regret.
pub(crate) fn regret_matching(regrets: &[f32], n_act: usize, n_combo: usize, out: &mut [f32]) {
    let uniform = 1.0 / n_act as f32;
    for i in 0..n_combo {
        let mut sum = 0.0f32;
        for a in 0..n_act {
            let r = regrets[a * n_combo + i];
            if r > 0.0 {
                sum += r;
            }
        }
        if sum > 0.0 {
            let inv = 1.0 / sum;
            for a in 0..n_act {
                let r = regrets[a * n_combo + i];
                out[a * n_combo + i] = if r > 0.0 { r * inv } else { 0.0 };
            }
        } else {
            for a in 0..n_act {
                out[a * n_combo + i] = uniform;
            }
        }
    }
}

/// Vector-form DCFR solver over any [`Game`].
pub struct Solver<G: Game> {
    game: G,
    /// Per node: start index into `regrets`/`strat_sum`, or `u32::MAX` for non-decision.
    offsets: Vec<u32>,
    /// Per node: `num_actions * combo_count(node, acting player)`, 0 for non-decision.
    sizes: Vec<u32>,
    regrets: Vec<f32>,
    strat_sum: Vec<f32>,
    scratch: Scratch,
    iteration: u64,
}

impl<G: Game> Solver<G> {
    /// Walks the tree once to size and offset the per-node storage.
    pub fn new(game: G) -> Self {
        let n = game.num_nodes();
        let mut offsets = vec![u32::MAX; n];
        let mut sizes = vec![0u32; n];
        let mut total = 0usize;
        for node in 0..n {
            if let NodeInfo::Decision { player, num_actions } = game.node(node as u32) {
                let size = num_actions * game.combo_count(node as u32, player);
                offsets[node] = total as u32;
                sizes[node] = size as u32;
                total += size;
            }
        }
        Solver {
            game,
            offsets,
            sizes,
            regrets: vec![0.0; total],
            strat_sum: vec![0.0; total],
            scratch: Scratch::new(),
            iteration: 0,
        }
    }

    pub fn game(&self) -> &G {
        &self.game
    }

    /// Iterations run so far.
    pub fn iterations(&self) -> u64 {
        self.iteration
    }

    /// DCFR discounting, applied once per full iteration `t` (1-based):
    /// positive regrets by `t^a / (t^a + 1)`, negative by `t^b / (t^b + 1)`, and the
    /// cumulative strategy by `(t / (t + 1))^g` so that iteration `t`'s contribution
    /// carries weight proportional to `t^g`.
    fn discount(&mut self, params: &DcfrParams) {
        let t = self.iteration as f64;
        let pos = {
            let ta = t.powf(params.alpha);
            (ta / (ta + 1.0)) as f32
        };
        let neg = {
            let tb = t.powf(params.beta);
            (tb / (tb + 1.0)) as f32
        };
        let strat = (t / (t + 1.0)).powf(params.gamma) as f32;
        for r in self.regrets.iter_mut() {
            *r *= if *r > 0.0 { pos } else { neg };
        }
        for s in self.strat_sum.iter_mut() {
            *s *= strat;
        }
    }
}

/// The iteration itself. `Sync` is required because the traversal hands `&G` to rayon
/// tasks at chance nodes; every `Game` in this crate satisfies it (they are plain
/// read-only tables built once).
impl<G: Game + Sync> Solver<G> {
    /// Runs `iterations` DCFR iterations.
    ///
    /// When `report_every > 0`, `report` is called after every `report_every`-th
    /// iteration with `(iteration, exploitability_chips, exploitability_pct_of_pot)`
    /// measured on the current average strategy. Computing that runs two full
    /// best-response walks, so keep the interval coarse on big trees.
    pub fn run(
        &mut self,
        iterations: u64,
        params: &DcfrParams,
        report_every: u64,
        mut report: impl FnMut(u64, f32, f32),
    ) {
        for _ in 0..iterations {
            self.iteration += 1;
            for hero in 0..2u8 {
                self.iterate(hero, params);
            }
            self.discount(params);
            if report_every > 0 && self.iteration.is_multiple_of(report_every) {
                let r = self.exploitability();
                report(self.iteration, r.chips, r.pct_of_pot);
            }
        }
    }

    /// One alternating half-iteration: update `hero`'s regrets and strategy sums
    /// against the opponent's current regret-matching strategy.
    fn iterate(&mut self, hero: u8, params: &DcfrParams) {
        let root = self.game.root();
        let opp = 1 - hero;
        let hn = self.game.combo_count(root, hero);
        let on = self.game.combo_count(root, opp);

        self.scratch.top = 0;
        let h_off = self.scratch.alloc(hn);
        let o_off = self.scratch.alloc(on);
        let out = self.scratch.alloc(hn);
        self.scratch.buf[h_off..h_off + hn].copy_from_slice(self.game.root_weights(hero));
        self.scratch.buf[o_off..o_off + on].copy_from_slice(self.game.root_weights(opp));

        let store = Store::new(&mut self.regrets, &mut self.strat_sum);
        let mut ctx = Cfr {
            game: &self.game,
            store,
            offsets: &self.offsets,
            scratch: &mut self.scratch,
            floor: params.floor_regrets_at_zero,
            fork: true,
        };
        ctx.walk(root, hero, h_off, hn, o_off, on, out);
    }
}

impl<G: Game> Solver<G> {
    /// Gamma-weighted average strategy at `node`, action-major
    /// (`[a * combo_count + i]`), normalized per combo.
    ///
    /// A combo that never reached `node` with positive probability has a zero
    /// cumulative strategy there and is reported as **uniform** over the actions.
    pub fn average_strategy(&self, node: u32) -> Vec<f32> {
        let size = self.sizes[node as usize] as usize;
        let mut out = vec![0.0; size];
        self.average_strategy_into(node, &mut out);
        out
    }

    /// Same as [`Solver::average_strategy`] into a caller-supplied buffer.
    pub fn average_strategy_into(&self, node: u32, out: &mut [f32]) {
        let NodeInfo::Decision { player, num_actions } = self.game.node(node) else {
            panic!("average_strategy on a non-decision node {node}");
        };
        let n_combo = self.game.combo_count(node, player);
        let off = self.offsets[node as usize] as usize;
        let sums = &self.strat_sum[off..off + num_actions * n_combo];
        let uniform = 1.0 / num_actions as f32;
        for i in 0..n_combo {
            let mut total = 0.0f32;
            for a in 0..num_actions {
                total += sums[a * n_combo + i].max(0.0);
            }
            if total > 0.0 {
                let inv = 1.0 / total;
                for a in 0..num_actions {
                    out[a * n_combo + i] = sums[a * n_combo + i].max(0.0) * inv;
                }
            } else {
                for a in 0..num_actions {
                    out[a * n_combo + i] = uniform;
                }
            }
        }
    }

    /// The average strategy as a [`StrategyProfile`] for [`crate::br`].
    pub fn average(&self) -> AverageStrategy<'_, G> {
        AverageStrategy { solver: self }
    }

    /// Exploitability of the current average strategy.
    pub fn exploitability(&self) -> ExploitReport {
        br::exploitability(&self.game, &self.average())
    }

    /// Player `hero`'s expected value in chips under the current average strategy
    /// profile (both players playing their average).
    pub fn expected_value(&self, hero: u8) -> f32 {
        br::expected_value(&self.game, hero, &self.average())
    }
}

/// Read-only view of a [`Solver`]'s average strategy.
pub struct AverageStrategy<'a, G: Game> {
    solver: &'a Solver<G>,
}

impl<G: Game> StrategyProfile for AverageStrategy<'_, G> {
    fn strategy_into(&self, node: u32, out: &mut [f32]) {
        self.solver.average_strategy_into(node, out);
    }
}

/// Borrowed traversal context. `game` is a plain shared reference (not a field of the
/// mutably-borrowed struct), so chance-edge slices stay valid across recursive calls.
struct Cfr<'a, G: Game> {
    game: &'a G,
    store: Store,
    offsets: &'a [u32],
    scratch: &'a mut Scratch,
    floor: bool,
    /// Whether this context is still allowed to fork at a chance node. True on the main
    /// thread, false inside a task — only the outermost chance node on a path forks, so
    /// there is exactly one fork level and the disjointness argument in [`Store`] holds.
    fork: bool,
}

impl<G: Game + Sync> Cfr<'_, G> {
    /// Writes hero's counterfactual value vector for the subtree at `node` into
    /// `scratch[out .. out + hn]`, updating hero's regrets and strategy sums on the way.
    ///
    /// `h_off`/`hn` is hero's reach vector, `o_off`/`on` the opponent's (which carries
    /// the chance weights).
    #[allow(clippy::too_many_arguments)]
    fn walk(
        &mut self,
        node: u32,
        hero: u8,
        h_off: usize,
        hn: usize,
        o_off: usize,
        on: usize,
        out: usize,
    ) {
        let g = self.game;
        match g.node(node) {
            NodeInfo::Terminal => {
                let (r, w) = read_write(&mut self.scratch.buf, o_off, on, out, hn);
                g.terminal_utility(node, hero, r, w);
            }
            NodeInfo::Chance { num_outcomes } if self.fork && num_outcomes >= PAR_MIN_OUTCOMES => {
                // PARALLEL MAP: one task per outcome, each with its own arena and its own
                // node-disjoint slice of storage (see `Store`). `map_init` keeps one arena
                // per rayon worker alive across the outcomes it happens to take, so the
                // steady state allocates only the returned value vectors.
                let (store, offsets, floor) = (self.store, self.offsets, self.floor);
                let parent: &[f32] = &self.scratch.buf;
                let results: Vec<Vec<f32>> = (0..num_outcomes)
                    .into_par_iter()
                    .map_init(Scratch::new, |sc, k| {
                        let edge = g.chance_outcome(node, k);
                        let map_h = edge.parent_of_child[hero as usize];
                        let map_o = edge.parent_of_child[(1 - hero) as usize];
                        let (chn, con) = (map_h.len(), map_o.len());
                        sc.top = 0;
                        let ch = sc.alloc(chn);
                        let co = sc.alloc(con);
                        let cout = sc.alloc(chn);
                        for (t, &p) in map_h.iter().enumerate() {
                            sc.buf[ch + t] = parent[h_off + p as usize];
                        }
                        for (t, &p) in map_o.iter().enumerate() {
                            sc.buf[co + t] = parent[o_off + p as usize] * edge.weight;
                        }
                        let mut ctx =
                            Cfr { game: g, store, offsets, scratch: sc, floor, fork: false };
                        ctx.walk(edge.child, hero, ch, chn, co, con, cout);
                        sc.buf[cout..cout + chn].to_vec()
                    })
                    .collect();

                // SEQUENTIAL REDUCE, ascending outcome order — the same order and the same
                // additions the sequential branch below performs, so the sum is bit-identical
                // however the tasks were scheduled.
                self.scratch.zero(out, hn);
                for (k, vals) in results.iter().enumerate() {
                    let map_h = g.chance_outcome(node, k).parent_of_child[hero as usize];
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[out + p as usize] += vals[t];
                    }
                }
            }
            NodeInfo::Chance { num_outcomes } => {
                self.scratch.zero(out, hn);
                for k in 0..num_outcomes {
                    let edge = g.chance_outcome(node, k);
                    let map_h = edge.parent_of_child[hero as usize];
                    let map_o = edge.parent_of_child[(1 - hero) as usize];
                    let (chn, con) = (map_h.len(), map_o.len());
                    let save = self.scratch.top;
                    let ch = self.scratch.alloc(chn);
                    let co = self.scratch.alloc(con);
                    let cout = self.scratch.alloc(chn);
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[ch + t] = self.scratch.buf[h_off + p as usize];
                    }
                    for (t, &p) in map_o.iter().enumerate() {
                        self.scratch.buf[co + t] =
                            self.scratch.buf[o_off + p as usize] * edge.weight;
                    }
                    self.walk(edge.child, hero, ch, chn, co, con, cout);
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[out + p as usize] += self.scratch.buf[cout + t];
                    }
                    self.scratch.top = save;
                }
            }
            NodeInfo::Decision { player, num_actions } if player == hero => {
                let off = self.offsets[node as usize] as usize;
                let size = num_actions * hn;
                let base = self.scratch.top;
                let sig = self.scratch.alloc(size);
                let evs = self.scratch.alloc(size);
                // SAFETY: `off..off + size` is exactly this node's own region, and this
                // task is the only one that reaches this node (see `Store`).
                let regrets = unsafe { self.store.regrets(off, size) };
                let strat = unsafe { self.store.strat(off, size) };
                regret_matching(
                    regrets,
                    num_actions,
                    hn,
                    &mut self.scratch.buf[sig..sig + size],
                );
                for a in 0..num_actions {
                    let save = self.scratch.top;
                    let ch = self.scratch.alloc(hn);
                    for i in 0..hn {
                        self.scratch.buf[ch + i] =
                            self.scratch.buf[h_off + i] * self.scratch.buf[sig + a * hn + i];
                    }
                    self.walk(g.child(node, a), hero, ch, hn, o_off, on, evs + a * hn);
                    self.scratch.top = save;
                }
                self.scratch.zero(out, hn);
                for a in 0..num_actions {
                    for i in 0..hn {
                        let v = self.scratch.buf[sig + a * hn + i] * self.scratch.buf[evs + a * hn + i];
                        self.scratch.buf[out + i] += v;
                    }
                }
                for a in 0..num_actions {
                    for i in 0..hn {
                        let regret = self.scratch.buf[evs + a * hn + i] - self.scratch.buf[out + i];
                        let slot = &mut regrets[a * hn + i];
                        *slot += regret;
                        if self.floor && *slot < 0.0 {
                            *slot = 0.0;
                        }
                        strat[a * hn + i] +=
                            self.scratch.buf[h_off + i] * self.scratch.buf[sig + a * hn + i];
                    }
                }
                self.scratch.top = base;
            }
            NodeInfo::Decision { player, num_actions } => {
                debug_assert_eq!(player, 1 - hero);
                let off = self.offsets[node as usize] as usize;
                let size = num_actions * on;
                let base = self.scratch.top;
                let sig = self.scratch.alloc(size);
                // SAFETY: read-only use of this node's own region; see `Store`.
                let regrets = unsafe { self.store.regrets(off, size) };
                regret_matching(
                    regrets,
                    num_actions,
                    on,
                    &mut self.scratch.buf[sig..sig + size],
                );
                self.scratch.zero(out, hn);
                for a in 0..num_actions {
                    let save = self.scratch.top;
                    let co = self.scratch.alloc(on);
                    let tmp = self.scratch.alloc(hn);
                    for i in 0..on {
                        self.scratch.buf[co + i] =
                            self.scratch.buf[o_off + i] * self.scratch.buf[sig + a * on + i];
                    }
                    self.walk(g.child(node, a), hero, h_off, hn, co, on, tmp);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::ChanceEdge;

    /// Smallest game that exercises the chance machinery the NLHE tree will lean on:
    /// a chance edge that **shrinks** both players' combo sets, with a different
    /// surviving subsequence per outcome.
    ///
    /// Three cards 0 < 1 < 2. A public card `p` is dealt uniformly, killing card `p` in
    /// both players' ranges, so each child has 2 live combos instead of 3 and the
    /// parent->child map differs per outcome (`p=0 -> [1,2]`, `p=1 -> [0,2]`,
    /// `p=2 -> [0,1]`). Each player then holds one of the two survivors — and since they
    /// cannot hold the same card, holding the higher survivor means *certainly* winning
    /// the showdown. Player 0 alone acts: fold for a flat -0.5, or show down for ±1.
    ///
    /// So the optimum is obvious and the value is hand-checkable: player 0 shows down
    /// the higher survivor (+1) and folds the lower (-0.5), each half the time, for
    /// **+0.25 per hand**.
    ///
    /// The normalizer is the interesting part and is why this test earns its keep. The
    /// root joint mass is 6 compatible pairs, but the chance edge kills a card, so only
    /// 2 ordered pairs survive each outcome and the outcome weights sum to 1:
    /// total terminal mass is `3 * (1/3) * 2 = 2`, not 6. A traversal that forgot to
    /// weight by the chance probability, or that expanded child values into the wrong
    /// parent slots, cannot land on +0.25.
    struct PublicCard {
        weights: [f32; 3],
        /// Surviving parent slots per public card.
        live: [[u32; 2]; 3],
    }

    impl PublicCard {
        fn new() -> Self {
            PublicCard { weights: [1.0; 3], live: [[1, 2], [0, 2], [0, 1]] }
        }
    }

    impl Game for PublicCard {
        fn root(&self) -> u32 {
            0
        }
        fn num_nodes(&self) -> usize {
            10
        }
        fn node(&self, node: u32) -> NodeInfo {
            match node {
                0 => NodeInfo::Chance { num_outcomes: 3 },
                1..=3 => NodeInfo::Decision { player: 0, num_actions: 2 },
                4..=9 => NodeInfo::Terminal,
                _ => unreachable!(),
            }
        }
        fn child(&self, node: u32, action: usize) -> u32 {
            // node 1+p: fold -> 4+p, showdown -> 7+p
            match action {
                0 => node + 3,
                1 => node + 6,
                _ => unreachable!(),
            }
        }
        fn combo_count(&self, node: u32, _player: u8) -> usize {
            if node == 0 {
                3
            } else {
                2
            }
        }
        fn root_weights(&self, _player: u8) -> &[f32] {
            &self.weights
        }
        fn chance_outcome(&self, node: u32, outcome: usize) -> ChanceEdge<'_> {
            assert_eq!(node, 0);
            let m = &self.live[outcome];
            ChanceEdge { child: 1 + outcome as u32, weight: 1.0 / 3.0, parent_of_child: [m, m] }
        }
        fn terminal_utility(&self, node: u32, hero: u8, opp_reach: &[f32], out: &mut [f32]) {
            // 4..=6 fold (flat -0.5 to player 0), 7..=9 showdown (higher survivor wins 1).
            let showdown = node >= 7;
            for (i, slot) in out.iter_mut().enumerate() {
                let mut v = 0.0;
                for (j, &w) in opp_reach.iter().enumerate() {
                    if i == j {
                        continue;
                    }
                    // Showdown is symmetric in hero: `i` is always hero's own card, so
                    // hero wins whenever its own slot is the higher survivor. The fold
                    // terminal is asymmetric: player 0 is the one giving up 0.5.
                    let u_hero = if showdown {
                        if i > j {
                            1.0
                        } else {
                            -1.0
                        }
                    } else if hero == 0 {
                        -0.5
                    } else {
                        0.5
                    };
                    v += w * u_hero;
                }
                *slot = v;
            }
        }
        fn normalizer(&self) -> f32 {
            2.0
        }
        fn root_pot(&self) -> f32 {
            1.0
        }
    }

    #[test]
    fn chance_edges_compact_and_expand_correctly() {
        let mut s = Solver::new(PublicCard::new());
        s.run(2_000, &DcfrParams::default(), 500, |i, chips, pct| {
            println!("public-card iter {i:>5}  exploitability {chips:.9} chips  {pct:.6}% of pot");
        });
        let e = s.exploitability();
        println!("public-card final {:?}", e);
        assert!(e.chips < 1e-4, "exploitability {}", e.chips);

        let v0 = s.expected_value(0);
        let v1 = s.expected_value(1);
        println!("public-card value: p0 {v0:.6}  p1 {v1:.6}");
        assert!((v0 - 0.25).abs() < 1e-3, "player 0 value {v0} != 0.25");
        assert!((v0 + v1).abs() < 1e-5, "values {v0} + {v1} are not zero-sum");

        // Fold the lower survivor, show down the higher, in all three subgames.
        for p in 0..3u32 {
            let st = s.average_strategy(1 + p);
            println!("public-card p={p} strategy fold {:?} show {:?}", &st[..2], &st[2..]);
            assert!(st[0] > 0.99, "should fold the low survivor at p={p}");
            assert!(st[3] > 0.99, "should show down the high survivor at p={p}");
        }
    }
}
