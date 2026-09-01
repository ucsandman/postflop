//! Terminal-node payoff primitives for vector CFR.
//!
//! Pure functions over combo arrays: no tree, no game trait, no solver state.
//! Given one side's hands and the other side's hands + reach probabilities,
//! they produce a per-hero-combo payoff vector.
//!
//! # Input shape
//! Each side is a pair of parallel slices: `&[Hand]` (the hands, one
//! `(Card, Card)` each) and, for the villain, `&[f32]` of the same length
//! holding that hand's reach. Parallel slices rather than a slice of structs
//! because CFR holds the hand list fixed for the whole solve and rewrites the
//! reach vector every iteration.
//!
//! Hands are assumed live on the board (no hand/board card overlap) - that is
//! the caller's job, and [`crate::range::Range::live_on`] does it. Hero and
//! villain hands may freely overlap *each other*: any hero/villain pair
//! sharing a card is an impossible matchup and contributes exactly zero. That
//! card removal is exact everywhere here, never an approximation.
//!
//! Output is written into a caller-provided `&mut [f32]`, indexed in the
//! caller's hero order (not sorted order). Every entry is overwritten, so the
//! buffer need not be zeroed first.
//!
//! # Cost
//! * [`fold_ev`]: O(N + M) - per-card villain reach sums plus
//!   inclusion-exclusion. Never O(N*M).
//! * [`SortedRanks::new`]: O(K) `eval7` calls + O(K log K) sort. Depends only
//!   on the board and the hand list, so the CFR layer should build it once per
//!   river board and reuse it across iterations.
//! * [`showdown_ev_ranked`]: O(N + M) merged sweep over two rank-sorted sides.
//! * [`showdown_ev`]: the two above combined (ranks rebuilt every call).
//!
//! The sweeps allocate nothing. Scratch state is fixed-size stack arrays
//! (`[f64; 52]` per-card sums, one `[f64; 1326]` per-combo lookup); the only
//! heap in this module is the `Vec`s inside [`SortedRanks`], built once and
//! cached, and the caller's output buffer.

use crate::cards::{Card, NUM_CARDS};
use crate::evaluator::eval7;
use crate::range::{combo_index, NUM_COMBOS};

/// A hole-card combo: two distinct cards. Order within the pair is irrelevant.
pub type Hand = (Card, Card);

/// The 7-card rank of `hand` on `board`. Higher is better; equal poker hands
/// compare bit-equal (see [`crate::evaluator::eval7`]).
#[inline]
pub fn hand_rank(board: &[Card; 5], hand: Hand) -> u32 {
    eval7(&[
        board[0], board[1], board[2], board[3], board[4], hand.0, hand.1,
    ])
}

#[inline]
fn shares_card(h: Hand, v: Hand) -> bool {
    h.0 == v.0 || h.0 == v.1 || h.1 == v.0 || h.1 == v.1
}

/// Accumulates total reach, per-card reach and per-combo reach over one side.
/// Returns the total. O(M).
fn accumulate(
    hands: &[Hand],
    reach: &[f32],
    by_card: &mut [f64; NUM_CARDS],
    by_combo: &mut [f64; NUM_COMBOS],
) -> f64 {
    let mut total = 0.0f64;
    for (h, &w) in hands.iter().zip(reach) {
        debug_assert!(
            h.0 != h.1 && (h.0 as usize) < NUM_CARDS && (h.1 as usize) < NUM_CARDS,
            "hand must be two distinct cards in 0..52"
        );
        let w = w as f64;
        total += w;
        by_card[h.0 as usize] += w;
        by_card[h.1 as usize] += w;
        by_combo[combo_index(h.0, h.1)] += w;
    }
    total
}

/// Per-hero-combo payoff when the hand ends without a showdown.
///
/// For each hero hand `h`, writes `payoff * R(h)` where `R(h)` is the villain
/// reach that does *not* share a card with `h`:
///
/// ```text
/// R(h) = total - by_card[h.0] - by_card[h.1] + reach of the villain hand (h.0, h.1)
/// ```
///
/// The add-back is the inclusion-exclusion correction: the only villain hand
/// counted in both per-card sums is the one holding both of hero's cards, i.e.
/// hero's exact combo.
///
/// The primitive is sign-agnostic and single-purpose: "villain folded, hero
/// wins the pot" and "hero folded, hero loses its investment" are the same
/// call with a different `payoff`. O(N + M).
///
/// # Panics
/// If `villain_reach.len() != villain.len()` or `out.len() != hero.len()`.
pub fn fold_ev(
    hero: &[Hand],
    villain: &[Hand],
    villain_reach: &[f32],
    payoff: f64,
    out: &mut [f32],
) {
    assert_eq!(villain.len(), villain_reach.len(), "villain/reach length mismatch");
    assert_eq!(hero.len(), out.len(), "out/hero length mismatch");

    let mut by_card = [0f64; NUM_CARDS];
    let mut by_combo = [0f64; NUM_COMBOS];
    let total = accumulate(villain, villain_reach, &mut by_card, &mut by_combo);

    for (h, o) in hero.iter().zip(out.iter_mut()) {
        let live = total - by_card[h.0 as usize] - by_card[h.1 as usize]
            + by_combo[combo_index(h.0, h.1)];
        *o = (payoff * live) as f32;
    }
}

/// One side's hands sorted ascending by 7-card rank on a fixed board.
///
/// Depends only on the board and the hand list, so it is the per-river
/// ranking the CFR layer caches and hands to [`showdown_ev_ranked`] every
/// iteration.
#[derive(Clone, Debug)]
pub struct SortedRanks {
    /// Indices into the source hand slice, ascending by rank.
    order: Vec<u32>,
    /// `ranks[i]` is the rank of `hands[order[i]]` - stored in sorted order so
    /// the sweep reads it without an indirection.
    ranks: Vec<u32>,
}

impl SortedRanks {
    /// Ranks every hand with [`eval7`] and sorts. O(K) evaluations plus
    /// O(K log K).
    pub fn new(board: &[Card; 5], hands: &[Hand]) -> SortedRanks {
        let by_hand: Vec<u32> = hands.iter().map(|&h| hand_rank(board, h)).collect();
        let mut order: Vec<u32> = (0..hands.len() as u32).collect();
        order.sort_unstable_by_key(|&i| by_hand[i as usize]);
        let ranks = order.iter().map(|&i| by_hand[i as usize]).collect();
        SortedRanks { order, ranks }
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

/// Per-hero-combo showdown EV, ranks precomputed.
///
/// `win` is the payoff per unit of villain reach hero beats, `lose` the payoff
/// per unit that beats hero, and `chop` the payoff per unit that ties. The
/// three are independent: `chop` is a parameter, never derived from the other
/// two. Under a linear (chip) payoff a split pot is worth `(win + lose) / 2`
/// and callers pass exactly that, but a non-linear payoff map - tournament
/// equity, where half a pot is not half the value of the pot - has a chop
/// value of its own, and this signature is what lets a caller state it.
///
/// For each hero hand `h` with rank `r`, over villain hands sharing no card
/// with `h`:
///
/// ```text
/// EV(h) = win * (reach with rank < r) + lose * (reach with rank > r)
///       + chop * (reach with rank == r)
/// ```
///
/// # Algorithm
/// Both sides arrive rank-sorted. Hero is walked in ascending rank runs; a
/// single monotone villain cursor accumulates every villain of lower rank into
/// running `below_total` / `below_card[52]` sums, and the equal-rank villain
/// run is processed atomically as a tie *group* (equal ranks are neither won
/// nor lost). Card removal inside the sweep is the same inclusion-exclusion as
/// [`fold_ev`], applied to each running sum, so it stays O(1) per hero combo:
///
/// * `beat  = below_total - below_card[a] - below_card[b]`
/// * `tie   = tie_total   - tie_card[a]   - tie_card[b]   + exact(a, b)`
/// * `live  = all_total   - all_card[a]   - all_card[b]   + exact(a, b)`
/// * `ahead = live - beat - tie`
///
/// `exact(a, b)` is the reach of the villain hand identical to hero's. It
/// needs no add-back in `beat`: a villain hand holding *both* of hero's cards
/// is hero's own hand, which necessarily has hero's rank and so always lands
/// in the tie group, never below or above.
///
/// The tie group's `tie_card` sums are built and unwound over the group's own
/// members (assigning `0.0` back, never subtracting), keeping the whole sweep
/// O(N + M) with no per-group 52-wide clear and no float drift.
///
/// # Panics
/// If any of the four side slices disagree in length, or `out.len() != hero.len()`.
#[allow(clippy::too_many_arguments)]
pub fn showdown_ev_ranked(
    hero: &[Hand],
    hero_ranks: &SortedRanks,
    villain: &[Hand],
    villain_ranks: &SortedRanks,
    villain_reach: &[f32],
    win: f64,
    lose: f64,
    chop: f64,
    out: &mut [f32],
) {
    assert_eq!(hero.len(), hero_ranks.len(), "hero/ranks length mismatch");
    assert_eq!(hero.len(), out.len(), "out/hero length mismatch");
    assert_eq!(villain.len(), villain_ranks.len(), "villain/ranks length mismatch");
    assert_eq!(villain.len(), villain_reach.len(), "villain/reach length mismatch");

    let mut all_card = [0f64; NUM_CARDS];
    let mut all_combo = [0f64; NUM_COMBOS];
    let all_total = accumulate(villain, villain_reach, &mut all_card, &mut all_combo);

    let mut below_card = [0f64; NUM_CARDS];
    let mut below_total = 0f64;
    // Sparse: only the cards of the current tie group are ever non-zero.
    let mut tie_card = [0f64; NUM_CARDS];

    let (n, m) = (hero.len(), villain.len());
    let mut vi = 0usize; // first villain of rank >= the hero rank being processed
    let mut hi = 0usize;

    while hi < n {
        let r = hero_ranks.ranks[hi];
        let mut hj = hi + 1;
        while hj < n && hero_ranks.ranks[hj] == r {
            hj += 1;
        }

        // Absorb every villain strictly below r. Monotone: each villain is
        // absorbed exactly once across the whole sweep. The previous tie
        // group flows through here on the way to the next hero rank.
        while vi < m && villain_ranks.ranks[vi] < r {
            let idx = villain_ranks.order[vi] as usize;
            let v = villain[idx];
            let w = villain_reach[idx] as f64;
            below_total += w;
            below_card[v.0 as usize] += w;
            below_card[v.1 as usize] += w;
            vi += 1;
        }

        // The equal-rank villain group, processed atomically.
        let mut vj = vi;
        let mut tie_total = 0f64;
        while vj < m && villain_ranks.ranks[vj] == r {
            let idx = villain_ranks.order[vj] as usize;
            let v = villain[idx];
            let w = villain_reach[idx] as f64;
            tie_total += w;
            tie_card[v.0 as usize] += w;
            tie_card[v.1 as usize] += w;
            vj += 1;
        }

        for k in hi..hj {
            let idx = hero_ranks.order[k] as usize;
            let h = hero[idx];
            let (a, b) = (h.0 as usize, h.1 as usize);
            let exact = all_combo[combo_index(h.0, h.1)];
            let live = all_total - all_card[a] - all_card[b] + exact;
            let beat = below_total - below_card[a] - below_card[b];
            let tie = tie_total - tie_card[a] - tie_card[b] + exact;
            let ahead = live - beat - tie;
            out[idx] = (win * beat + lose * ahead + chop * tie) as f32;
        }

        // Unwind the group's card sums by assignment, so the array returns to
        // exactly zero. `vi` deliberately stays at the group start: the group
        // is absorbed into `below_*` by the next hero rank's absorb loop.
        for t in vi..vj {
            let v = villain[villain_ranks.order[t] as usize];
            tie_card[v.0 as usize] = 0.0;
            tie_card[v.1 as usize] = 0.0;
        }

        hi = hj;
    }
}

/// [`showdown_ev_ranked`] with the rankings built on the spot. Convenience for
/// callers with nothing to cache; the CFR layer should cache [`SortedRanks`]
/// per river board and call [`showdown_ev_ranked`] directly.
#[allow(clippy::too_many_arguments)]
pub fn showdown_ev(
    board: &[Card; 5],
    hero: &[Hand],
    villain: &[Hand],
    villain_reach: &[f32],
    win: f64,
    lose: f64,
    chop: f64,
    out: &mut [f32],
) {
    let hr = SortedRanks::new(board, hero);
    let vr = SortedRanks::new(board, villain);
    showdown_ev_ranked(hero, &hr, villain, &vr, villain_reach, win, lose, chop, out);
}

// ---------------------------------------------------------------------------
// Slow reference
// ---------------------------------------------------------------------------

pub mod reference {
    //! Naive O(N*M) double loops, written for obvious correctness and kept as
    //! the oracle the fast paths are verified against.
    //!
    //! These write `f64` rather than `f32` on purpose: keeping the oracle at
    //! full precision means a property-test tolerance measures the fast path's
    //! error, not the oracle's.

    use super::{hand_rank, shares_card, Hand};
    use crate::cards::Card;

    /// See [`super::fold_ev`].
    pub fn fold_ev(
        hero: &[Hand],
        villain: &[Hand],
        villain_reach: &[f32],
        payoff: f64,
        out: &mut [f64],
    ) {
        for (i, &h) in hero.iter().enumerate() {
            let mut live = 0f64;
            for (&v, &w) in villain.iter().zip(villain_reach) {
                if shares_card(h, v) {
                    continue; // impossible matchup: contributes zero
                }
                live += w as f64;
            }
            out[i] = payoff * live;
        }
    }

    /// See [`super::showdown_ev_ranked`]. `chop` is a parameter here too: the
    /// oracle must not keep the `(win + lose) / 2` linearity the fast path gave
    /// up, or it stops being able to falsify it.
    #[allow(clippy::too_many_arguments)]
    pub fn showdown_ev(
        board: &[Card; 5],
        hero: &[Hand],
        villain: &[Hand],
        villain_reach: &[f32],
        win: f64,
        lose: f64,
        chop: f64,
        out: &mut [f64],
    ) {
        for (i, &h) in hero.iter().enumerate() {
            let hr = hand_rank(board, h);
            let mut ev = 0f64;
            for (&v, &w) in villain.iter().zip(villain_reach) {
                if shares_card(h, v) {
                    continue; // impossible matchup: contributes zero
                }
                let vr = hand_rank(board, v);
                let w = w as f64;
                ev += if hr > vr {
                    win * w
                } else if hr < vr {
                    lose * w
                } else {
                    chop * w
                };
            }
            out[i] = ev;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{mask_of, parse_cards};
    use crate::range::Range;
    use rand::seq::SliceRandom;
    use rand::{Rng, SeedableRng};
    use rand::rngs::StdRng;

    fn board5(s: &str) -> [Card; 5] {
        let c = parse_cards(s).unwrap();
        assert_eq!(c.len(), 5);
        [c[0], c[1], c[2], c[3], c[4]]
    }

    fn hand(s: &str) -> Hand {
        let c = parse_cards(s).unwrap();
        assert_eq!(c.len(), 2);
        (c[0], c[1])
    }

    /// Every combo live on `board`, in canonical order (1081 for a 5-card board).
    fn live_hands(board: &[Card; 5]) -> Vec<Hand> {
        Range::uniform_full()
            .live_on(mask_of(board))
            .combos
            .iter()
            .map(|c| c.cards)
            .collect()
    }

    fn assert_close(got: &[f32], want: &[f64], tol: f64, what: &str) {
        assert_eq!(got.len(), want.len());
        for (i, (&g, &w)) in got.iter().zip(want).enumerate() {
            let d = (g as f64 - w).abs();
            assert!(d <= tol, "{what}: combo {i} fast={g} naive={w} diff={d} > {tol}");
        }
    }

    // -- hand-computed micro examples ------------------------------------

    /// Hero {AsKs, 2c3c} vs villain {AsQs:0.5, 7d8d:0.25, 2c3c:1.0}, payoff 4.
    /// total = 1.75.
    /// AsKs blocks AsQs (shares As): live = 1.75 - 0.5 = 1.25 -> 4*1.25 = 5.0
    /// 2c3c blocks the identical villain combo only. Per-card sums are
    /// by_card[2c]=1.0, by_card[3c]=1.0, exact(2c,3c)=1.0, so
    /// live = 1.75 - 1.0 - 1.0 + 1.0 = 0.75 (= 0.5 + 0.25, by inspection)
    /// -> 4*0.75 = 3.0
    #[test]
    fn micro_fold_hand_computed() {
        let hero = [hand("AsKs"), hand("2c3c")];
        let villain = [hand("AsQs"), hand("7d8d"), hand("2c3c")];
        let reach = [0.5f32, 0.25, 1.0];
        let mut out = [0f32; 2];
        fold_ev(&hero, &villain, &reach, 4.0, &mut out);
        assert!((out[0] - 5.0).abs() < 1e-6, "{out:?}");
        assert!((out[1] - 3.0).abs() < 1e-6, "{out:?}");
    }

    /// Board 2c 7d 9h Js 4s (rainbow-ish, no straight or flush possible with
    /// any of these holdings). win = 3.0, lose = -1.0 => chop = 1.0.
    ///
    /// Villain: AhAs:0.5 (AA), QcQd:0.25 (QQ), KcKd:1.0 (KK). total = 1.75.
    /// Rank order QQ < KK < AA.
    ///
    /// H1 = AcAd (AA): shares nothing. Ties AhAs (0.5), beats QQ+KK (1.25).
    ///      EV = 1.0*0.5 + 3.0*1.25 = 4.25
    /// H2 = KcKd (KK): the *identical* combo to villain KcKd, so that matchup
    ///      is impossible and its 1.0 of tie reach drops out entirely.
    ///      Loses to AhAs (0.5), beats QcQd (0.25).
    ///      EV = -1.0*0.5 + 3.0*0.25 = 0.25
    /// H3 = AcAh (AA): blocks AhAs, so the tie disappears. Beats QQ+KK (1.25).
    ///      EV = 3.0*1.25 = 3.75   <- visibly below H1's 4.25: the blocker.
    #[test]
    fn micro_showdown_hand_computed() {
        let board = board5("2c 7d 9h Js 4s");
        let hero = [hand("AcAd"), hand("KcKd"), hand("AcAh")];
        let villain = [hand("AhAs"), hand("QcQd"), hand("KcKd")];
        let reach = [0.5f32, 0.25, 1.0];
        let mut out = [0f32; 3];
        showdown_ev(&board, &hero, &villain, &reach, 3.0, -1.0, 1.0, &mut out);
        assert!((out[0] - 4.25).abs() < 1e-6, "{out:?}");
        assert!((out[1] - 0.25).abs() < 1e-6, "{out:?}");
        assert!((out[2] - 3.75).abs() < 1e-6, "{out:?}");
        // The blocker moves EV by exactly the chop it removed.
        assert!((out[0] - out[2] - 1.0 * 0.5).abs() < 1e-6, "{out:?}");
    }

    /// Villain range is three combos, all containing Ah. A hero combo holding
    /// Ah blocks the entire range (live reach 0.0); one that holds none of it
    /// sees all 3.0. Payoff 1.0, so the numbers are the reach itself.
    #[test]
    fn blocker_fold_three_combos_exact() {
        let hero = [hand("Ah2c"), hand("Kd2c")];
        let villain = [hand("AhAc"), hand("AhAd"), hand("AhAs")];
        let reach = [1.0f32; 3];
        let mut out = [0f32; 2];
        fold_ev(&hero, &villain, &reach, 1.0, &mut out);
        assert_eq!(out[0], 0.0, "Ah blocks the whole villain range");
        assert_eq!(out[1], 3.0, "Kd2c blocks none of it");
    }

    // -- tie groups ------------------------------------------------------

    /// Royal flush on the board: every seven-card hand is that same royal, so
    /// every possible matchup is a chop. With win = 2.0 / lose = 0.0 the chop
    /// is 1.0, and each hero combo must earn exactly its card-removal-corrected
    /// live villain reach - which is what `fold_ev`'s independent
    /// inclusion-exclusion path (checked against the naive oracle here)
    /// computes.
    #[test]
    fn board_plays_everything_chops() {
        let board = board5("As Ks Qs Js Ts");
        let hands = live_hands(&board);
        assert_eq!(hands.len(), 1081);

        // Sanity: the whole field really is one rank group.
        let r0 = hand_rank(&board, hands[0]);
        assert!(hands.iter().all(|&h| hand_rank(&board, h) == r0));

        let mut rng = StdRng::seed_from_u64(0xC0FFEE);
        let reach: Vec<f32> = (0..hands.len()).map(|_| rng.gen::<f32>()).collect();

        let mut fast = vec![0f32; hands.len()];
        showdown_ev(&board, &hands, &hands, &reach, 2.0, 0.0, 1.0, &mut fast);

        // chop = 1.0, so EV == live villain reach == naive fold at payoff 1.0.
        let mut want = vec![0f64; hands.len()];
        reference::fold_ev(&hands, &hands, &reach, 1.0, &mut want);
        assert_close(&fast, &want, 1e-4, "board plays");

        // And it is genuinely non-trivial: card removal moves every entry off
        // the raw total.
        let total: f64 = reach.iter().map(|&w| w as f64).sum();
        assert!(fast.iter().all(|&v| (v as f64) < total - 1.0));
    }

    /// `chop` is a parameter, not `(win + lose) / 2`.
    ///
    /// The royal-flush board makes every matchup a tie, so `win` and `lose`
    /// touch nothing and the whole output is the chop payoff times each hero
    /// combo's card-removal-corrected live villain reach. `win = 10`,
    /// `lose = -10` has midpoint `0`, so a path that rederived the chop would
    /// return all zeros for both cases below; the second case demands `7 * live`
    /// instead. This is the gate that says the fast path, the convenience
    /// wrapper and the oracle all read the parameter they were handed.
    ///
    /// A tournament payoff map needs exactly this: half a pot is not worth half
    /// the value of a pot in equity, so the chop payoff is its own number.
    #[test]
    fn chop_is_not_derived() {
        let board = board5("As Ks Qs Js Ts");
        let hands = live_hands(&board);
        assert_eq!(hands.len(), 1081);
        let r0 = hand_rank(&board, hands[0]);
        assert!(hands.iter().all(|&h| hand_rank(&board, h) == r0), "one rank group");

        let mut rng = StdRng::seed_from_u64(0x0CD0_0CD0);
        let reach: Vec<f32> = (0..hands.len()).map(|_| rng.gen::<f32>()).collect();

        // live[i] is what `chop = 1` must pay, computed by the independent
        // inclusion-exclusion path in `fold_ev`'s oracle.
        let mut live = vec![0f64; hands.len()];
        reference::fold_ev(&hands, &hands, &reach, 1.0, &mut live);
        let (lo, hi) = live.iter().fold((f64::MAX, 0f64), |(a, b), &v| (a.min(v), b.max(v)));
        assert!(lo > 0.0, "every hero combo must see some live villain reach");

        let hr = SortedRanks::new(&board, &hands);

        // chop = 0 with win/lose an order of magnitude larger: every entry zero.
        let mut zero = vec![0f32; hands.len()];
        showdown_ev(&board, &hands, &hands, &reach, 10.0, -10.0, 0.0, &mut zero);
        assert!(
            zero.iter().all(|&v| v == 0.0),
            "chop = 0 must zero every entry; worst = {}",
            zero.iter().cloned().fold(0f32, |a, b| a.max(b.abs()))
        );

        // chop = 7, same win/lose: 7 * live on all three code paths.
        let want: Vec<f64> = live.iter().map(|&v| 7.0 * v).collect();

        let mut fast = vec![0f32; hands.len()];
        showdown_ev(&board, &hands, &hands, &reach, 10.0, -10.0, 7.0, &mut fast);
        assert_close(&fast, &want, 1e-2, "chop = 7 (wrapper)");

        let mut ranked = vec![0f32; hands.len()];
        showdown_ev_ranked(&hands, &hr, &hands, &hr, &reach, 10.0, -10.0, 7.0, &mut ranked);
        assert_eq!(fast, ranked, "ranked entry point must agree bit-for-bit");

        let mut oracle = vec![0f64; hands.len()];
        reference::showdown_ev(&board, &hands, &hands, &reach, 10.0, -10.0, 7.0, &mut oracle);
        assert_close(&fast, &oracle, 1e-2, "chop = 7 (oracle)");
        let worst = fast
            .iter()
            .zip(&oracle)
            .map(|(&f, &o)| (f as f64 - o).abs())
            .fold(0f64, f64::max);

        // The derived value would have been 0, so `want` must be far from it.
        assert!(7.0 * lo > 1.0, "the 7 * live signal must be visibly non-zero");
        println!(
            "chop_is_not_derived: combos = {}, tie group = {} (all matchups tie), live reach {lo:.4}..{hi:.4}, derived chop would be {}, parameter chop = 7 pays {:.4}..{:.4}, worst fast-vs-oracle diff {worst:.3e} (tol 1e-2)",
            hands.len(),
            hands.len(),
            (10.0f64 + -10.0) * 0.5,
            7.0 * lo,
            7.0 * hi,
        );
    }

    /// Board A K Q J with one blank: every hand containing a ten makes the
    /// same broadway straight (a large tie group), while everything else
    /// spreads across other ranks.
    #[test]
    fn partial_tie_groups() {
        let board = board5("Ac Kd Qh Js 7c");
        let hands = live_hands(&board);

        let mut counts = std::collections::HashMap::<u32, usize>::new();
        for &h in &hands {
            *counts.entry(hand_rank(&board, h)).or_default() += 1;
        }
        let biggest = *counts.values().max().unwrap();
        assert!(biggest >= 10, "expected a large tie group, biggest = {biggest}");
        assert!(counts.len() >= 3, "expected several distinct ranks, got {}", counts.len());

        let mut rng = StdRng::seed_from_u64(7);
        let mut hero = hands.clone();
        hero.shuffle(&mut rng);
        hero.truncate(300);
        let mut villain = hands.clone();
        villain.shuffle(&mut rng);
        villain.truncate(400);
        let reach: Vec<f32> = (0..villain.len()).map(|_| rng.gen::<f32>()).collect();

        let mut fast = vec![0f32; hero.len()];
        showdown_ev(&board, &hero, &villain, &reach, 1.0, -1.0, 0.0, &mut fast);
        let mut want = vec![0f64; hero.len()];
        reference::showdown_ev(&board, &hero, &villain, &reach, 1.0, -1.0, 0.0, &mut want);
        assert_close(&fast, &want, 1e-4, "partial ties");
    }

    // -- properties ------------------------------------------------------

    /// Random board, random hero/villain subsets (tiny through the full 1081),
    /// random weights, random payoff sign. Fast must match the naive oracle.
    fn random_case(rng: &mut StdRng, size: Option<usize>) -> ([Card; 5], Vec<Hand>, Vec<Hand>, Vec<f32>) {
        let mut deck: Vec<Card> = (0..52).collect();
        deck.shuffle(rng);
        let board = [deck[0], deck[1], deck[2], deck[3], deck[4]];
        let live = live_hands(&board);

        let pick = |rng: &mut StdRng| -> Vec<Hand> {
            let k = size.unwrap_or_else(|| rng.gen_range(1..=60));
            let mut pool = live.clone();
            pool.shuffle(rng);
            pool.truncate(k.min(pool.len()));
            pool
        };
        let hero = pick(rng);
        let villain = pick(rng);
        let reach: Vec<f32> = (0..villain.len()).map(|_| rng.gen::<f32>()).collect();
        (board, hero, villain, reach)
    }

    #[test]
    fn property_fold_matches_reference() {
        let mut rng = StdRng::seed_from_u64(0x5EED_F01D);
        let mut widest = 0usize;
        for case in 0..205 {
            let size = match case {
                0..=4 => Some(case + 1),        // tiny
                200..=204 => Some(1081),        // full
                _ => None,                      // random 1..=60
            };
            let (_, hero, villain, reach) = random_case(&mut rng, size);
            let payoff: f64 = rng.gen_range(-1.0..=1.0);
            widest = widest.max(hero.len().max(villain.len()));

            let mut fast = vec![0f32; hero.len()];
            fold_ev(&hero, &villain, &reach, payoff, &mut fast);
            let mut want = vec![0f64; hero.len()];
            reference::fold_ev(&hero, &villain, &reach, payoff, &mut want);
            assert_close(&fast, &want, 1e-4, &format!("fold case {case}"));
        }
        assert_eq!(widest, 1081, "the sweep must have covered full-width sides");
    }

    #[test]
    fn property_showdown_matches_reference() {
        let mut rng = StdRng::seed_from_u64(0xD15EA5E);
        let mut widest = 0usize;
        for case in 0..202 {
            let size = match case {
                0..=4 => Some(case + 1),        // tiny
                200..=201 => Some(1081),        // full
                _ => None,                      // random 1..=60
            };
            let (board, hero, villain, reach) = random_case(&mut rng, size);
            let win: f64 = rng.gen_range(0.0..=1.0);
            let lose: f64 = rng.gen_range(-1.0..=0.0);
            // Chop is drawn independently, not as (win + lose) / 2: a fast path
            // that ignored the parameter and rederived it would pass otherwise.
            let chop: f64 = rng.gen_range(-1.0..=1.0);
            widest = widest.max(hero.len().max(villain.len()));

            let mut fast = vec![0f32; hero.len()];
            showdown_ev(&board, &hero, &villain, &reach, win, lose, chop, &mut fast);
            let mut want = vec![0f64; hero.len()];
            reference::showdown_ev(&board, &hero, &villain, &reach, win, lose, chop, &mut want);
            assert_close(&fast, &want, 1e-4, &format!("showdown case {case}"));
        }
        assert_eq!(widest, 1081, "the sweep must have covered full-width sides");
    }

    /// The cached-ranks entry point must agree with the convenience wrapper.
    #[test]
    fn ranked_variant_matches_convenience() {
        let mut rng = StdRng::seed_from_u64(11);
        let (board, hero, villain, reach) = random_case(&mut rng, Some(200));
        let mut a = vec![0f32; hero.len()];
        showdown_ev(&board, &hero, &villain, &reach, 2.5, -2.5, 0.0, &mut a);

        let hr = SortedRanks::new(&board, &hero);
        let vr = SortedRanks::new(&board, &villain);
        let mut b = vec![0f32; hero.len()];
        showdown_ev_ranked(&hero, &hr, &villain, &vr, &reach, 2.5, -2.5, 0.0, &mut b);
        assert_eq!(a, b);
    }

    #[test]
    fn empty_sides() {
        let board = board5("2c 7d 9h Js 4s");
        let hero = [hand("AcAd")];
        let mut out = [1.0f32];
        fold_ev(&hero, &[], &[], 5.0, &mut out);
        assert_eq!(out[0], 0.0);
        out[0] = 1.0;
        showdown_ev(&board, &hero, &[], &[], 3.0, -1.0, 1.0, &mut out);
        assert_eq!(out[0], 0.0);
        // Empty hero writes nothing and must not panic.
        showdown_ev(&board, &[], &hero, &[1.0], 3.0, -1.0, 1.0, &mut []);
    }
}
