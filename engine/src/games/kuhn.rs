//! Kuhn poker — milestone 1 validation game for the vector CFR core.
//!
//! Three cards J(0) / Q(1) / K(2), one dealt to each player, both ante 1 (pot 2), one
//! bet size of 1, one betting round.
//!
//! ```text
//!                          n0  P0 to act
//!            check ────────┴──────── bet
//!             n1 P1                   n2 P1
//!      check ──┴── bet          fold ──┴── call
//!       n3         n4 P0         n5         n6
//!   showdown  fold ─┴─ call   P1 folds   showdown
//!   (±1)       n7       n8    (P0 +1)    (±2)
//!           (P0 -1)  (±2)
//! ```
//!
//! No chance nodes: the deal is folded into the root combo vectors (3 combos each,
//! weight 1) and card removal is applied at the terminals, where a matchup of two equal
//! cards is impossible and contributes nothing.
//!
//! Utilities follow the crate convention — net chips relative to the start of the hand,
//! so both antes are sunk and every terminal is exactly zero-sum.

use crate::game::{ChanceEdge, Game, NodeInfo};

const P0: u8 = 0;
const P1: u8 = 1;

/// Kuhn poker. Stateless; construct with [`Kuhn::new`].
#[derive(Clone, Copy, Debug, Default)]
pub struct Kuhn;

impl Kuhn {
    pub fn new() -> Self {
        Kuhn
    }

    /// `out[i] = sum over j != i of opp_reach[j] * (stake if i beats j else -stake)`.
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

    /// A fold terminal: the winner takes `amount` chips regardless of cards, still with
    /// the equal-card matchup removed.
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

impl Game for Kuhn {
    fn root(&self) -> u32 {
        0
    }

    fn num_nodes(&self) -> usize {
        9
    }

    fn node(&self, node: u32) -> NodeInfo {
        match node {
            0 => NodeInfo::Decision { player: P0, num_actions: 2 }, // check / bet
            1 => NodeInfo::Decision { player: P1, num_actions: 2 }, // check / bet
            2 => NodeInfo::Decision { player: P1, num_actions: 2 }, // fold / call
            4 => NodeInfo::Decision { player: P0, num_actions: 2 }, // fold / call
            3 | 5 | 6 | 7 | 8 => NodeInfo::Terminal,
            _ => unreachable!("bad kuhn node {node}"),
        }
    }

    fn child(&self, node: u32, action: usize) -> u32 {
        match (node, action) {
            (0, 0) => 1,
            (0, 1) => 2,
            (1, 0) => 3,
            (1, 1) => 4,
            (2, 0) => 5,
            (2, 1) => 6,
            (4, 0) => 7,
            (4, 1) => 8,
            _ => unreachable!("bad kuhn edge {node}/{action}"),
        }
    }

    fn combo_count(&self, _node: u32, _player: u8) -> usize {
        3
    }

    fn root_weights(&self, _player: u8) -> &[f32] {
        &[1.0, 1.0, 1.0]
    }

    fn chance_outcome(&self, node: u32, _outcome: usize) -> ChanceEdge<'_> {
        unreachable!("kuhn has no chance nodes (node {node})")
    }

    fn terminal_utility(&self, node: u32, hero: u8, opp_reach: &[f32], out: &mut [f32]) {
        match node {
            // check-check showdown for the 2-chip pot: winner nets +1.
            3 => Self::showdown(1.0, opp_reach, out),
            // P0 bet, P1 folded: P0 wins P1's ante.
            5 => Self::fold(if hero == P0 { 1.0 } else { -1.0 }, opp_reach, out),
            // bet-call and check-bet-call showdowns for the 4-chip pot: winner nets +2.
            6 | 8 => Self::showdown(2.0, opp_reach, out),
            // P0 checked, P1 bet, P0 folded: P0 loses its ante.
            7 => Self::fold(if hero == P0 { -1.0 } else { 1.0 }, opp_reach, out),
            _ => unreachable!("kuhn node {node} is not terminal"),
        }
    }

    fn normalizer(&self) -> f32 {
        // 3 x 3 combo pairs minus the 3 impossible same-card pairs.
        6.0
    }

    fn root_pot(&self) -> f32 {
        2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::br;
    use crate::cfr::{DcfrParams, Solver};

    /// The known analytic equilibrium family of Kuhn poker (P1 = first actor = our
    /// player 0, P2 = our player 1):
    ///
    /// * P1 bets J with probability `a` for any `a` in `[0, 1/3]`, bets K with `3a`,
    ///   and always checks Q.
    /// * P1 facing a bet after checking: always folds J, always calls K, calls Q with
    ///   probability `a + 1/3`.
    /// * P2 facing a bet: always calls K, calls Q with probability `1/3`, folds J.
    /// * P2 after a check: always bets K, bets J with probability `1/3`, checks Q.
    /// * Game value to P1 is `-1/18`.
    const TOL: f32 = 0.02;

    fn solve(iters: u64) -> Solver<Kuhn> {
        let mut s = Solver::new(Kuhn::new());
        s.run(iters, &DcfrParams::default(), 0, |_, _, _| {});
        s
    }

    #[test]
    fn milestone1_kuhn_converges_to_the_analytic_equilibrium() {
        let params = DcfrParams::default();
        let mut s = Solver::new(Kuhn::new());
        let mut log: Vec<(u64, f32, f32)> = Vec::new();
        s.run(10_000, &params, 100, |i, c, p| log.push((i, c, p)));
        for (i, chips, pct) in &log {
            println!("kuhn iter {i:>6}  exploitability {chips:.9} chips  {pct:.6}% of pot");
        }
        let curve: Vec<(u64, f32, f32)> = log
            .iter()
            .copied()
            .filter(|(i, _, _)| matches!(i, 100 | 1_000 | 10_000))
            .collect();
        assert_eq!(curve.len(), 3, "expected reports at 100/1000/10000");

        // 1. converged, and monotone non-increasing along the way.
        let final_expl = curve[2].1;
        assert!(final_expl < 1e-3, "exploitability {final_expl} not < 1e-3 chips");
        for w in curve.windows(2) {
            assert!(
                w[1].1 <= w[0].1 + 1e-6,
                "exploitability rose from {} at {} to {} at {}",
                w[0].1,
                w[0].0,
                w[1].1,
                w[1].0
            );
        }

        // 2. game value to P1 (player 0) is -1/18.
        let value = s.expected_value(0);
        assert!(
            (value - (-1.0 / 18.0)).abs() < 2e-3,
            "root value {value} != -1/18"
        );
        // zero-sum cross-check.
        let v1 = s.expected_value(1);
        assert!((value + v1).abs() < 1e-4, "values {value} + {v1} are not zero-sum");

        // 3. the equilibrium family constraints.
        let n0 = s.average_strategy(0); // P1 open: [check, bet] x [J, Q, K]
        let n1 = s.average_strategy(1); // P2 after check: [check, bet]
        let n2 = s.average_strategy(2); // P2 facing bet: [fold, call]
        let n4 = s.average_strategy(4); // P1 facing bet after check: [fold, call]
        let bet = |v: &[f32], card: usize| v[3 + card];
        let call = |v: &[f32], card: usize| v[3 + card];

        let a = bet(&n0, 0); // P1 bets J with probability a
        println!(
            "kuhn strategy: P1 bet J {:.4} Q {:.4} K {:.4} | P1 call Q {:.4} \
             | P2 bet-after-check J {:.4} K {:.4} | P2 call J {:.4} Q {:.4} K {:.4}",
            a,
            bet(&n0, 1),
            bet(&n0, 2),
            call(&n4, 1),
            bet(&n1, 0),
            bet(&n1, 2),
            call(&n2, 0),
            call(&n2, 1),
            call(&n2, 2),
        );
        assert!(a <= 1.0 / 3.0 + TOL, "P1 J-bet {a} outside [0, 1/3]");
        assert!((bet(&n0, 2) - 3.0 * a).abs() < TOL, "P1 K-bet != 3 * J-bet");
        assert!(bet(&n0, 1) < TOL, "P1 should check Q, bets {}", bet(&n0, 1));
        assert!(
            (call(&n4, 1) - (a + 1.0 / 3.0)).abs() < TOL,
            "P1 Q-call {} != a + 1/3",
            call(&n4, 1)
        );
        assert!(call(&n4, 2) > 1.0 - TOL, "P1 should always call K");
        assert!(call(&n4, 0) < TOL, "P1 should always fold J");
        assert!(call(&n2, 2) > 1.0 - TOL, "P2 should always call K");
        assert!((call(&n2, 1) - 1.0 / 3.0).abs() < TOL, "P2 Q-call != 1/3");
        assert!(call(&n2, 0) < TOL, "P2 should always fold J");
        assert!(bet(&n1, 2) > 1.0 - TOL, "P2 should always bet K after a check");
        assert!((bet(&n1, 0) - 1.0 / 3.0).abs() < TOL, "P2 J-bluff != 1/3");
        assert!(bet(&n1, 1) < TOL, "P2 should check Q behind");
    }

    #[test]
    fn best_response_beats_a_uniform_profile() {
        // The measure has to be able to see a bad strategy, not just certify a good one.
        let game = Kuhn::new();
        let uniform = br::exploitability(&game, &br::UniformProfile(&game));
        println!("kuhn uniform-profile exploitability {:?}", uniform);
        assert!(uniform.chips > 0.1, "uniform profile should be very exploitable");
        assert!(uniform.pct_of_pot > 5.0);
    }

    #[test]
    fn average_strategy_is_deterministic() {
        let a = solve(500);
        let b = solve(500);
        for node in [0u32, 1, 2, 4] {
            assert_eq!(
                a.average_strategy(node),
                b.average_strategy(node),
                "node {node} differed between identical runs"
            );
        }
        assert_eq!(a.exploitability(), b.exploitability());
    }

    #[test]
    fn regret_floor_variant_also_converges() {
        let params = DcfrParams { floor_regrets_at_zero: true, ..DcfrParams::default() };
        let mut s = Solver::new(Kuhn::new());
        s.run(5_000, &params, 0, |_, _, _| {});
        let e = s.exploitability();
        println!("kuhn DCFR+ (floored regrets) exploitability {:?}", e);
        assert!(e.chips < 1e-3, "floored-regret run exploitability {}", e.chips);
    }

    #[test]
    fn never_reached_combos_report_uniform() {
        // Zero iterations run: nothing has been reached, so every combo is uniform.
        let s = Solver::new(Kuhn::new());
        assert_eq!(s.average_strategy(0), vec![0.5; 6]);
    }
}
