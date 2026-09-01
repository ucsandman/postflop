//! AKQ half-street toy game — milestone 2 validation for the vector CFR core.
//!
//! Three cards Q(0) < K(1) < A(2), one dealt to each player. A dead pot of `P` chips is
//! already in the middle, contributed `P/2` by each player. Player 0 (OOP) is forced to
//! check in the dark, so the tree starts with player 1 (IP) to act:
//!
//! ```text
//!                 n0  P1 (IP) to act
//!        check ────┴──── bet B
//!         n1              n2  P0 to act
//!     showdown      fold ──┴── call
//!     (±P/2)         n3         n4
//!                 (P1 +P/2)  showdown
//!                            (±(P/2+B))
//! ```
//!
//! No chance nodes; the deal lives in the root combo vectors and card removal is applied
//! at the terminals. Utilities are net chips relative to the start of the hand, so the
//! `P/2` each player already put in is sunk and every terminal is zero-sum.

use crate::game::{ChanceEdge, Game, NodeInfo};

/// AKQ half-street game with a dead pot of `pot` and one bet size `bet`.
#[derive(Clone, Debug)]
pub struct Akq {
    pot: f32,
    bet: f32,
    weights: [f32; 3],
}

impl Akq {
    /// `pot` is the dead pot P, `bet` is the bet size B. Both must be positive.
    pub fn new(pot: f32, bet: f32) -> Self {
        assert!(pot > 0.0 && bet > 0.0);
        Akq { pot, bet, weights: [1.0; 3] }
    }

    pub fn pot(&self) -> f32 {
        self.pot
    }

    pub fn bet(&self) -> f32 {
        self.bet
    }

    fn showdown(stake: f32, opp_reach: &[f32], out: &mut [f32]) {
        for (i, slot) in out.iter_mut().enumerate() {
            let mut v = 0.0;
            for (j, &w) in opp_reach.iter().enumerate() {
                if i == j {
                    continue; // same card: impossible matchup
                }
                v += w * if i > j { stake } else { -stake };
            }
            *slot = v;
        }
    }

    fn fold(amount: f32, opp_reach: &[f32], out: &mut [f32]) {
        for (i, slot) in out.iter_mut().enumerate() {
            let mut v = 0.0;
            for (j, &w) in opp_reach.iter().enumerate() {
                if i == j {
                    continue;
                }
                v += w * amount;
            }
            *slot = v;
        }
    }
}

impl Game for Akq {
    fn root(&self) -> u32 {
        0
    }

    fn num_nodes(&self) -> usize {
        5
    }

    fn node(&self, node: u32) -> NodeInfo {
        match node {
            0 => NodeInfo::Decision { player: 1, num_actions: 2 }, // check / bet
            2 => NodeInfo::Decision { player: 0, num_actions: 2 }, // fold / call
            1 | 3 | 4 => NodeInfo::Terminal,
            _ => unreachable!("bad akq node {node}"),
        }
    }

    fn child(&self, node: u32, action: usize) -> u32 {
        match (node, action) {
            (0, 0) => 1,
            (0, 1) => 2,
            (2, 0) => 3,
            (2, 1) => 4,
            _ => unreachable!("bad akq edge {node}/{action}"),
        }
    }

    fn combo_count(&self, _node: u32, _player: u8) -> usize {
        3
    }

    fn root_weights(&self, _player: u8) -> &[f32] {
        &self.weights
    }

    fn chance_outcome(&self, node: u32, _outcome: usize) -> ChanceEdge<'_> {
        unreachable!("akq has no chance nodes (node {node})")
    }

    fn terminal_utility(&self, node: u32, hero: u8, opp_reach: &[f32], out: &mut [f32]) {
        match node {
            1 => Self::showdown(self.pot / 2.0, opp_reach, out),
            // player 0 folded: player 1 takes the dead pot, player 0 loses its half.
            3 => Self::fold(
                if hero == 0 { -self.pot / 2.0 } else { self.pot / 2.0 },
                opp_reach,
                out,
            ),
            4 => Self::showdown(self.pot / 2.0 + self.bet, opp_reach, out),
            _ => unreachable!("akq node {node} is not terminal"),
        }
    }

    fn normalizer(&self) -> f32 {
        6.0
    }

    fn root_pot(&self) -> f32 {
        self.pot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cfr::{DcfrParams, Solver};

    const Q: usize = 0;
    const K: usize = 1;
    const A: usize = 2;
    const TOL: f32 = 0.02;

    /// Closed form for this three-card half-street game, derived from the two
    /// indifference conditions. Cards Q < K < A, dead pot `P`, bet `B`.
    ///
    /// Pure parts first. Player 1 (the bettor) always bets A (it is never called by a
    /// better hand and gets called by K) and never bets K: betting K wins exactly the
    /// same `P/2` against Q that checking does, and loses an extra `B` against A, so it
    /// is strictly dominated. Player 0 always calls A (only a bluffing Q ever bets into
    /// it) and always folds Q (only A ever bets into it). That leaves two mixed
    /// frequencies: `b` = player 1 bluffs Q, `c` = player 0 calls K.
    ///
    /// **Player 0's K is indifferent** fixes `b`. Conditional on holding K and facing a
    /// bet, the opponent holds A (bets with probability 1) or Q (bets with `b`), each
    /// with prior weight 1:
    ///
    /// ```text
    ///   call:  1 * -(P/2 + B)  +  b * +(P/2 + B)
    ///   fold:  (1 + b) * -P/2
    ///   =>  -(P/2 + B) + b(P/2 + B) = -(1 + b)P/2
    ///   =>  -B + bP + bB = 0
    ///   =>  b = B / (P + B)
    /// ```
    ///
    /// The classic bluff-to-value ratio drops straight out of that:
    /// `b / (b + 1) = B / (P + 2B)`.
    ///
    /// **Player 1's Q is indifferent** fixes `c`. Conditional on holding Q, the opponent
    /// holds A (always calls) or K (calls with `c`):
    ///
    /// ```text
    ///   check: -P/2 + -P/2 = -P
    ///   bet:   -(P/2 + B)  +  [ c * -(P/2 + B) + (1 - c) * P/2 ]
    ///   bet - check = P - B - c(P + B)
    ///   =>  c = (P - B) / (P + B)
    /// ```
    ///
    /// Note this is *not* the textbook MDF `P/(P+B)` for the calling hand itself,
    /// because half of player 0's range is the nut A which always calls. Player 0's
    /// **total** defence frequency against a bluff is `(1 + c)/2`, and substituting
    /// gives exactly `P/(P+B)`. The textbook number is recovered at the range level.
    ///
    /// # Degeneracy at `B >= P`
    ///
    /// `c = (P - B)/(P + B)` is only a probability while `B <= P`. At `B = P` it hits
    /// the boundary `c = 0`, and there the two indifference conditions stop pinning `b`:
    /// with `c = 0` the bet/check difference for Q is `P - B - 0 = 0` for *every* `b`,
    /// while player 0's K strictly prefers folding for any `b < B/(P+B)`. So the Nash
    /// set at `B = P` is the whole segment `{ c = 0, b in [0, B/(P+B)] }`, and no solver
    /// can be asked to land on a particular point of it. Only the `B < P` cases have a
    /// unique equilibrium; [`run_case`] asserts the segment membership instead when the
    /// closed form comes back at the boundary. Measured: DCFR lands at `b ~ 0.003` for
    /// `P = B = 1`, with exploitability 0.0 — a valid equilibrium of that segment.
    fn closed_form(p: f32, b_size: f32) -> (f32, f32) {
        (b_size / (p + b_size), (p - b_size) / (p + b_size))
    }

    /// Player 1's EV with Q, per opponent combo pair, for betting vs checking.
    fn p1_q_evs(p: f32, b_size: f32, c: f32) -> (f32, f32) {
        let win = p / 2.0;
        let lose = -(p / 2.0 + b_size);
        let bet = lose + (c * lose + (1.0 - c) * win);
        let check = -p;
        (bet, check)
    }

    /// Player 0's EV with K facing a bet, for calling vs folding.
    fn p0_k_evs(p: f32, b_size: f32, b: f32) -> (f32, f32) {
        let call = -(p / 2.0 + b_size) + b * (p / 2.0 + b_size);
        let fold = (1.0 + b) * -(p / 2.0);
        (call, fold)
    }

    fn run_case(p: f32, b_size: f32) {
        let (want_b, want_c) = closed_form(p, b_size);
        let mut s = Solver::new(Akq::new(p, b_size));
        let params = DcfrParams::default();
        let mut last = (0u64, 0.0f32, 0.0f32);
        s.run(20_000, &params, 1_000, |i, chips, pct| {
            println!("akq P={p} B={b_size} iter {i:>6}  exploitability {chips:.9} chips  {pct:.6}% of pot");
            last = (i, chips, pct);
        });
        assert!(last.1 < 1e-3, "P={p} B={b_size}: exploitability {} not < 1e-3", last.1);

        let n0 = s.average_strategy(0); // player 1: [check, bet] x [Q, K, A]
        let n2 = s.average_strategy(2); // player 0: [fold, call] x [Q, K, A]
        let bet = |card: usize| n0[3 + card];
        let call = |card: usize| n2[3 + card];
        println!(
            "akq P={p} B={b_size} solved: bet Q {:.4} K {:.4} A {:.4} | call Q {:.4} K {:.4} A {:.4}",
            bet(Q), bet(K), bet(A), call(Q), call(K), call(A)
        );

        // pure parts
        assert!(bet(A) > 1.0 - TOL, "P1 should always value-bet A, bets {}", bet(A));
        assert!(bet(K) < TOL, "P1 should never bet K, bets {}", bet(K));
        assert!(call(A) > 1.0 - TOL, "P0 should always call A, calls {}", call(A));
        assert!(call(Q) < TOL, "P0 should always fold Q, calls {}", call(Q));

        // mixed frequencies against the closed form
        let (b, c) = (bet(Q), call(K));
        let (bet_q, check_q) = p1_q_evs(p, b_size, c);
        let (call_k, fold_k) = p0_k_evs(p, b_size, b);
        println!("akq P={p} B={b_size} P1 Q: bet EV {bet_q:.6} vs check EV {check_q:.6}");
        println!("akq P={p} B={b_size} P0 K: call EV {call_k:.6} vs fold EV {fold_k:.6}");

        if want_c > TOL {
            // Unique interior equilibrium: both frequencies are pinned.
            assert!((b - want_b).abs() < TOL, "bluff freq {b} != closed form {want_b}");
            assert!((c - want_c).abs() < TOL, "K-call freq {c} != closed form {want_c}");

            // the two textbook ratios the closed form implies
            let ratio = b / (b + bet(A));
            let want_ratio = b_size / (p + 2.0 * b_size);
            assert!(
                (ratio - want_ratio).abs() < TOL,
                "bluff-to-total ratio {ratio} != B/(P+2B) {want_ratio}"
            );
            let mdf = (call(A) + c) / 2.0;
            let want_mdf = p / (p + b_size);
            assert!((mdf - want_mdf).abs() < TOL, "defence freq {mdf} != P/(P+B) {want_mdf}");

            // both indifference conditions hold at the SOLVED frequencies
            assert!(
                (bet_q - check_q).abs() < 0.05,
                "P1 Q not indifferent: bet {bet_q} vs check {check_q}"
            );
            assert!(
                (call_k - fold_k).abs() < 0.05,
                "P0 K not indifferent: call {call_k} vs fold {fold_k}"
            );
        } else {
            // Boundary (B >= P): the Nash set is the segment { c = 0, b in [0, want_b] }.
            // See `closed_form` for why. Assert membership, plus the one indifference
            // that still binds and the weak best response that replaces the other.
            assert!(c < TOL, "K-call freq {c} should be pinned at 0 for B >= P");
            assert!(
                b >= -TOL && b <= want_b + TOL,
                "bluff freq {b} outside the equilibrium segment [0, {want_b}]"
            );
            assert!(
                (bet_q - check_q).abs() < 0.05,
                "P1 Q not indifferent: bet {bet_q} vs check {check_q}"
            );
            assert!(
                call_k <= fold_k + 0.05,
                "P0 K should weakly prefer folding: call {call_k} vs fold {fold_k}"
            );
        }
    }

    #[test]
    fn milestone2_akq_pot1_bet1() {
        // B = P: the boundary case. c = 0 and any b in [0, 1/2] is an equilibrium.
        run_case(1.0, 1.0);
    }

    #[test]
    fn milestone2_akq_pot1_bet_half() {
        // b = 1/3, c = 1/3 (fully interior, unique).
        run_case(1.0, 0.5);
    }

    #[test]
    fn milestone2_akq_pot1_bet_quarter() {
        // b = 1/5, c = 3/5 (fully interior, unique) — a second closed-form match at a
        // different bet size, so the interior branch is exercised twice.
        run_case(1.0, 0.25);
    }

    #[test]
    fn akq_is_deterministic() {
        let solve = || {
            let mut s = Solver::new(Akq::new(1.0, 0.5));
            s.run(1_000, &DcfrParams::default(), 0, |_, _, _| {});
            (s.average_strategy(0), s.average_strategy(2), s.exploitability())
        };
        assert_eq!(solve(), solve());
    }
}
