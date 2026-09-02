//! Exact Malmuth-Harville tournament equity.
//!
//! One value per seat, in payout units (dollars, or whatever `payouts` is
//! denominated in). The model: the probability a seat finishes first is its
//! share of the chips in play; conditional on a set of seats having already
//! finished 1st..kth, the next place is again decided by chip share among the
//! seats that are left. That recursion is exact, so the cost is a DP over the
//! *set* of players already placed: `O(n * sum_{k<K} C(n, k))` for `K` paid
//! places. 9 seats and 3 paid places evaluate 46 subsets.
//!
//! What this model ignores, deliberately: blind levels, position, skill
//! differences, future hands, and the existence of other tables. It is not
//! Malmuth-Weitzman and not FGS.
//!
//! This module is standalone arithmetic. It reads no config and is wired into
//! no solve path.

use std::collections::BTreeMap;

/// Exact Malmuth-Harville equity, one value per stack, in payout units.
///
/// `payouts[0]` is first prize. A payout list shorter than `stacks` is fine;
/// the unlisted places pay zero. A zero (busted) stack gets zero equity and
/// never enters a denominator.
///
/// With at least as many positive stacks as paid places the returned values sum
/// to `payouts.iter().sum()`, up to float rounding.
pub fn equity(stacks: &[f64], payouts: &[f64]) -> Vec<f64> {
    equity_counted(stacks, payouts).0
}

/// `equity`, plus the number of (set, place) states the DP evaluated. The count
/// is the volume this function processed; tests print it.
fn equity_counted(stacks: &[f64], payouts: &[f64]) -> (Vec<f64>, usize) {
    let n = stacks.len();
    debug_assert!(n <= 32, "u32 subset mask caps at 32 seats, got {n}");
    let places = payouts.len().min(n);
    let total: f64 = stacks.iter().sum();
    let mut ev = vec![0.0; n];
    let mut subsets = 0usize;
    // g[S] = P(the set S occupies places 1..|S| in some order), keyed by bitmask.
    // BTreeMap, not HashMap: the accumulation order of the f64 sums below is then
    // fixed, so two runs of the same input agree bit for bit.
    let mut g: BTreeMap<u32, f64> = BTreeMap::from([(0u32, 1.0)]);
    for place in 0..places {
        let mut next: BTreeMap<u32, f64> = BTreeMap::new();
        for (&set, &p) in &g {
            subsets += 1;
            let remaining = total
                - (0..n)
                    .filter(|&i| set >> i & 1 == 1)
                    .map(|i| stacks[i])
                    .sum::<f64>();
            for i in 0..n {
                if set >> i & 1 == 1 || stacks[i] <= 0.0 {
                    continue;
                }
                // Absolute chips, never `1 - sum(fractions)`: the subtraction
                // form loses precision once a stack dwarfs the rest.
                let q = p * stacks[i] / remaining;
                ev[i] += q * payouts[place];
                *next.entry(set | 1 << i).or_insert(0.0) += q;
            }
        }
        g = next;
    }
    (ev, subsets)
}

/// Risk premium of a chip: `(eq_now - eq_lose) / (eq_win - eq_now)` for `hero`
/// staking `risk` chips against `villain`.
///
/// 1.0 means chips won and chips lost are worth the same (chipEV). Above 1.0
/// the loss hurts more than the win helps, which is the whole of ICM pressure.
/// The result is asymmetric: `bubble_factor(.., a, b, r) != bubble_factor(.., b, a, r)`
/// whenever the two stacks differ.
///
/// `risk` must not exceed either seat's stack; a negative stack is not a
/// meaningful input to `equity`.
pub fn bubble_factor(
    stacks: &[f64],
    payouts: &[f64],
    hero: usize,
    villain: usize,
    risk: f64,
) -> f64 {
    debug_assert!(hero != villain, "hero and villain must be different seats");
    debug_assert!(
        risk <= stacks[hero] && risk <= stacks[villain],
        "risk {risk} exceeds a seat's stack"
    );
    let now = equity(stacks, payouts)[hero];
    let mut w = stacks.to_vec();
    w[hero] += risk;
    w[villain] -= risk;
    let mut l = stacks.to_vec();
    l[hero] -= risk;
    l[villain] += risk;
    (now - equity(&l, payouts)[hero]) / (equity(&w, payouts)[hero] - now)
}

// required_equity(bf) = bf / (bf + 1). Do NOT hardcode RP = bf/(bf+1) - 0.5; it
// is only exact for a symmetric all-in with no dead money. Compute both from
// `equity`.

/// Every ordered pair's bubble factor, `m[hero][villain]`, each measured at that
/// pair's effective risk `min(stacks[hero], stacks[villain])` — the most either
/// seat can lose to the other in one hand.
///
/// The matrix is asymmetric: a covering seat and the seat it covers do not price
/// the same flip the same way, which is why this is a matrix and not one number
/// per seat.
///
/// Two degenerate cells, both reported rather than hidden:
/// * the diagonal, and any pair where a seat is busted, is `1.0` — no chips can
///   move, so a chip is worth a chip;
/// * a pair where winning cannot raise the hero's equity at all (the hero already
///   holds every prize the structure pays) is `f64::INFINITY`.
///
/// Cost is `n^2` pairs times two [`equity`] evaluations. Nothing is cached.
pub fn bubble_factors(stacks: &[f64], payouts: &[f64]) -> Vec<Vec<f64>> {
    let n = stacks.len();
    let now = equity(stacks, payouts);
    let mut m = vec![vec![1.0; n]; n];
    for hero in 0..n {
        for villain in 0..n {
            let risk = stacks[hero].min(stacks[villain]);
            if hero == villain || risk <= 0.0 {
                continue;
            }
            let mut w = stacks.to_vec();
            w[hero] += risk;
            w[villain] -= risk;
            let mut l = stacks.to_vec();
            l[hero] -= risk;
            l[villain] += risk;
            let up = equity(&w, payouts)[hero] - now[hero];
            let down = now[hero] - equity(&l, payouts)[hero];
            m[hero][villain] = if up > 0.0 { down / up } else { f64::INFINITY };
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    fn assert_close(got: &[f64], want: &[f64], tol: f64, what: &str) {
        assert_eq!(got.len(), want.len(), "{what}: length");
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            assert!(
                (g - w).abs() <= tol,
                "{what}: seat {i} got {g} want {w} (tol {tol})"
            );
        }
    }

    /// Three seats, two places paid. Hand-checkable:
    /// seat 0 wins 50% of the time and is second 33.93% of the time.
    #[test]
    fn three_seats_two_places() {
        let stacks = [50.0, 30.0, 20.0];
        let payouts = [70.0, 30.0];
        let (ev, subsets) = equity_counted(&stacks, &payouts);
        println!("three_seats_two_places: subsets evaluated = {subsets}, ev = {ev:?}");
        assert_eq!(subsets, 4, "1 empty set + 3 singletons");
        assert_close(&ev, &[45.1786, 32.25, 22.5714], 1e-4, "3-seat MH");
    }

    /// Four seats, four places paid, real final-table numbers.
    #[test]
    fn four_seats_four_places() {
        let stacks = [150000.0, 98750.0, 45500.0, 13250.0];
        let payouts = [425.0, 280.0, 130.0, 75.0];
        let (ev, subsets) = equity_counted(&stacks, &payouts);
        println!("four_seats_four_places: subsets evaluated = {subsets}, ev = {ev:?}");
        assert_eq!(subsets, 15, "C(4,0)+C(4,1)+C(4,2)+C(4,3)");
        assert_close(&ev, &[323.20, 278.12, 195.79, 112.89], 1e-2, "4-seat MH");
    }

    /// Negative control for the test above: Malmuth-Harville is NOT chip
    /// proportion. A `equity` that just scaled chip share would pass every
    /// invariant test in this module and fail here.
    #[test]
    fn is_not_chip_proportional() {
        let stacks = [150000.0, 98750.0, 45500.0, 13250.0];
        let payouts = [425.0, 280.0, 130.0, 75.0];
        let ev = equity(&stacks, &payouts);
        let total: f64 = stacks.iter().sum();
        let prize: f64 = payouts.iter().sum();
        let proportional: Vec<f64> = stacks.iter().map(|s| s / total * prize).collect();
        println!("is_not_chip_proportional: mh = {ev:?}, chip-proportional = {proportional:?}");
        assert_close(
            &proportional,
            &[443.90, 292.24, 134.65, 39.21],
            1e-2,
            "chip-proportional reference",
        );
        let gap = ev
            .iter()
            .zip(&proportional)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f64, f64::max);
        assert!(gap > 100.0, "MH must not collapse to chip share, gap {gap}");
    }

    /// Winner-take-all is the one structure where MH *is* chip proportion:
    /// every seat's equity is its chip share of the single prize.
    #[test]
    fn winner_take_all_is_chip_proportion() {
        let stacks = [150000.0, 98750.0, 45500.0, 13250.0];
        let payouts = [910.0];
        let (ev, subsets) = equity_counted(&stacks, &payouts);
        let total: f64 = stacks.iter().sum();
        let want: Vec<f64> = stacks.iter().map(|s| s / total * 910.0).collect();
        println!("winner_take_all_is_chip_proportion: subsets evaluated = {subsets}, ev = {ev:?}");
        assert_eq!(subsets, 1, "one place paid, only the empty set is expanded");
        assert_close(&ev, &want, 1e-12, "WTA");
    }

    /// The 10-man SNG the plan's bubble numbers come from. Nine-seat variants
    /// are the volume case: 46 subsets for 3 paid places.
    #[test]
    fn ten_man_sng_bubble() {
        let payouts = [500.0, 300.0, 200.0];
        let flat = [1500.0; 10];
        let (ev, subsets) = equity_counted(&flat, &payouts);
        println!("ten_man_sng_bubble flat: subsets evaluated = {subsets}, ev = {ev:?}");
        assert_eq!(subsets, 1 + 10 + 45, "C(10,0)+C(10,1)+C(10,2)");
        assert_close(&ev, &[100.0; 10], 1e-12, "10 equal stacks");

        // Hero doubles through one seat: 3000 vs a bust, eight seats untouched.
        let mut won = flat;
        won[0] = 3000.0;
        won[1] = 0.0;
        let (ev_won, subsets_won) = equity_counted(&won, &payouts);
        println!("ten_man_sng_bubble doubled: subsets evaluated = {subsets_won}, ev = {ev_won:?}");
        assert_eq!(subsets_won, 1 + 9 + 36, "46: the busted seat is still a slot");
        assert!(
            (ev_won[0] - 184.4444).abs() < 1e-4,
            "hero after doubling: {}",
            ev_won[0]
        );
        assert_eq!(ev_won[1], 0.0, "busted seat gets nothing");

        // A 1500-chip flip on that table costs more than it pays.
        let bf = bubble_factor(&flat, &payouts, 0, 1, 1500.0);
        let req = bf / (bf + 1.0);
        println!("ten_man_sng_bubble: bubble factor = {bf:.6}, required equity = {req:.6}");
        assert!((bf - 1.1842).abs() < 1e-4, "bubble factor {bf}");
        assert!((req - 0.5422).abs() < 1e-4, "required equity {req}");
    }

    /// Bubble factor is asymmetric between a covering and a covered seat, which
    /// is why Stage 2 needs a pairwise matrix and not one number per seat.
    #[test]
    fn bubble_factor_is_asymmetric() {
        let stacks = [6000.0, 1500.0, 1500.0, 1000.0, 1000.0];
        let payouts = [500.0, 300.0, 200.0];
        let big = bubble_factor(&stacks, &payouts, 0, 1, 1000.0);
        let small = bubble_factor(&stacks, &payouts, 1, 0, 1000.0);
        println!("bubble_factor_is_asymmetric: chip leader {big:.6}, short stack {small:.6}");
        assert!(
            (big - small).abs() > 0.05,
            "covering {big} vs covered {small}"
        );
        assert!(big > 1.0 && small > 1.0, "both above chipEV on a bubble");
    }

    /// The pairwise matrix the CLI and the web tile read. It must agree with
    /// `bubble_factor` at the pair's effective risk, must be asymmetric on a
    /// covering/covered pair, and must not report pressure where no chips can move.
    #[test]
    fn bubble_factors_is_a_pairwise_asymmetric_matrix() {
        let stacks = [6000.0, 1500.0, 1500.0, 1000.0, 0.0];
        let payouts = [500.0, 300.0, 200.0];
        let m = bubble_factors(&stacks, &payouts);
        let n = stacks.len();
        assert_eq!(m.len(), n);
        let mut pairs = 0;
        let mut asymmetric = 0;
        for (hero, row) in m.iter().enumerate() {
            assert_eq!(row.len(), n);
            assert_eq!(row[hero], 1.0, "diagonal seat {hero}");
            for (villain, &f) in row.iter().enumerate() {
                if hero == villain {
                    continue;
                }
                pairs += 1;
                if (f - m[villain][hero]).abs() > 1e-9 {
                    asymmetric += 1;
                }
            }
        }
        println!(
            "bubble_factors: {n} seats, {pairs} ordered pairs evaluated, {asymmetric} asymmetric, \
             leader-vs-short {:.6} / {:.6}, busted column {:?}",
            m[0][3], m[3][0], m[4]
        );
        // Covering vs covered: BF(i,j) != BF(j,i). The gate the plan names.
        assert!(
            (m[0][3] - m[3][0]).abs() > 0.05,
            "chip leader {} vs short stack {} priced the same flip alike",
            m[0][3],
            m[3][0]
        );
        assert!(m[0][3] > 1.0 && m[3][0] > 1.0, "both above chipEV on a bubble");
        // Equal stacks (seats 1 and 2) are symmetric to each other, so the matrix
        // is not asymmetric by construction — it is asymmetric where the stacks are.
        assert!(
            (m[1][2] - m[2][1]).abs() < 1e-12,
            "equal stacks must price each other identically"
        );
        // Seat 4 is busted: nothing can move either way.
        assert!(
            m[4].iter().all(|&v| v == 1.0) && (0..n).all(|h| m[h][4] == 1.0),
            "a busted seat cannot apply or feel pressure: {:?}",
            m[4]
        );
        // Agreement with the single-pair function at the same risk.
        let single = bubble_factor(&stacks, &payouts, 0, 3, 1000.0);
        assert!(
            (m[0][3] - single).abs() < 1e-12,
            "matrix {} vs bubble_factor {single}",
            m[0][3]
        );
    }

    /// Invariants that must hold for any stack vector: the prize pool is fully
    /// distributed, equal stacks are equal, and a busted seat gets zero without
    /// poisoning anyone else's equity.
    #[test]
    fn invariants_over_random_vectors() {
        let mut rng = StdRng::seed_from_u64(0x1C3_1CE);
        let mut cases = 0;
        let mut subsets_total = 0;
        let mut worst_sum_err = 0.0f64;
        for case in 0..20 {
            let n = rng.gen_range(2..=9usize);
            let places = rng.gen_range(1..=n.min(4));
            let mut payouts: Vec<f64> = (0..places).map(|_| rng.gen_range(1.0..500.0)).collect();
            payouts.sort_by(|a, b| b.partial_cmp(a).unwrap()); // non-increasing
            let stacks: Vec<f64> = (0..n).map(|_| rng.gen_range(1.0..200000.0)).collect();

            let (ev, subsets) = equity_counted(&stacks, &payouts);
            subsets_total += subsets;
            cases += 1;

            let prize: f64 = payouts.iter().sum();
            let got: f64 = ev.iter().sum();
            let err = (got - prize).abs() / prize;
            worst_sum_err = worst_sum_err.max(err);
            assert!(
                err < 1e-9,
                "case {case}: equity sums to {got}, prize pool is {prize}"
            );
            assert!(ev.iter().all(|e| *e >= 0.0), "case {case}: negative equity");

            // Equal stacks share equally, exactly: every term in the DP is the
            // same value, so the sums are bit-identical across seats.
            let flat = vec![stacks[0]; n];
            let ev_flat = equity(&flat, &payouts);
            assert!(
                ev_flat.iter().all(|e| *e == ev_flat[0]),
                "case {case}: equal stacks disagree: {ev_flat:?}"
            );
            assert!(
                (ev_flat.iter().sum::<f64>() - prize).abs() / prize < 1e-9,
                "case {case}: equal stacks lose the pool"
            );

            // Busting the last seat gives it zero and leaves the pool intact
            // whenever enough live seats remain to fill the paid places.
            if n - 1 >= places {
                let mut busted = stacks.clone();
                busted[n - 1] = 0.0;
                let ev_busted = equity(&busted, &payouts);
                assert_eq!(ev_busted[n - 1], 0.0, "case {case}: busted seat paid");
                assert!(
                    (ev_busted.iter().sum::<f64>() - prize).abs() / prize < 1e-9,
                    "case {case}: busted seat leaked the pool"
                );
            }
        }
        println!(
            "invariants_over_random_vectors: {cases} cases, {subsets_total} subsets evaluated, \
             worst relative sum error {worst_sum_err:.3e}"
        );
        assert_eq!(cases, 20);
    }
}
