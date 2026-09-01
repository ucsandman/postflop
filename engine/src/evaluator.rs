//! Poker hand evaluation.
//!
//! [`eval7`] and [`eval5`] return a comparable `u32` where higher is better and
//! two hands whose best five cards are equal in poker compare *exactly* equal
//! (showdown logic downstream depends on that).
//!
//! Encoding: `category << 20 | tiebreak`, where `tiebreak` holds up to five
//! 4-bit rank fields, most significant first (bits 16, 12, 8, 4, 0). Unused
//! fields are zero. Ordering inside a category is therefore plain lexicographic
//! comparison of the ranks that matter, which is exactly poker's rule.
//!
//! The fast path is table-driven: rank-multiplicity bitmasks built with a
//! carry-chain over the cards, one 8 KiB straight table and one 32 KiB flush
//! table, both built at compile time by `const fn`. No allocation, no branches
//! on card count.
//!
//! [`reference`] holds a deliberately slow, obviously correct evaluator that
//! produces the *same* values; the tests below check the fast path against it.

use crate::cards::Card;

/// Bit position of the hand-category field.
const CAT_SHIFT: u32 = 20;

const CAT_HIGH_CARD: u32 = 0;
const CAT_PAIR: u32 = 1;
const CAT_TWO_PAIR: u32 = 2;
const CAT_TRIPS: u32 = 3;
const CAT_STRAIGHT: u32 = 4;
const CAT_FLUSH: u32 = 5;
const CAT_FULL_HOUSE: u32 = 6;
const CAT_QUADS: u32 = 7;
const CAT_STRAIGHT_FLUSH: u32 = 8;

/// Human-readable name of the category encoded in a value from [`eval5`] /
/// [`eval7`]. Returns `"unknown"` for values the evaluators cannot produce.
pub fn hand_category(rank_value: u32) -> &'static str {
    match rank_value >> CAT_SHIFT {
        CAT_HIGH_CARD => "high card",
        CAT_PAIR => "pair",
        CAT_TWO_PAIR => "two pair",
        CAT_TRIPS => "trips",
        CAT_STRAIGHT => "straight",
        CAT_FLUSH => "flush",
        CAT_FULL_HOUSE => "full house",
        CAT_QUADS => "quads",
        CAT_STRAIGHT_FLUSH => "straight flush",
        _ => "unknown",
    }
}

// ---------------------------------------------------------------------------
// Compile-time tables
// ---------------------------------------------------------------------------

/// Index of the highest set bit. Caller must ensure `mask != 0`.
#[inline(always)]
const fn high_bit(mask: u16) -> u32 {
    debug_assert!(mask != 0);
    15 - mask.leading_zeros()
}

/// Packs the highest `n` ranks of `mask` into the tiebreak field, most
/// significant first. `n` must be at most 5.
#[inline(always)]
const fn top_n(mask: u16, n: u32) -> u32 {
    debug_assert!(n <= 5);
    let mut m = mask;
    let mut v = 0u32;
    let mut i = 0u32;
    while i < n && m != 0 {
        let r = 15 - m.leading_zeros();
        m &= !(1u16 << r);
        v |= r << (16 - 4 * i);
        i += 1;
    }
    v
}

/// Highest rank completing a five-card straight in `mask`, plus one; 0 if the
/// mask holds no straight. The wheel (A-5-4-3-2) reports the five (rank 3).
const fn straight_high_plus1(mask: u16) -> u32 {
    let x = mask & (mask >> 1) & (mask >> 2) & (mask >> 3) & (mask >> 4);
    if x != 0 {
        // Bit `i` of `x` means ranks i..=i+4 are all present.
        return (15 - x.leading_zeros()) + 4 + 1;
    }
    const WHEEL: u16 = (1 << 12) | 0b1111;
    if mask & WHEEL == WHEEL {
        return 3 + 1;
    }
    0
}

const fn build_straight_table() -> [u8; 8192] {
    let mut t = [0u8; 8192];
    let mut m = 0usize;
    while m < 8192 {
        t[m] = straight_high_plus1(m as u16) as u8;
        m += 1;
    }
    t
}

const fn build_flush_table() -> [u32; 8192] {
    let mut t = [0u32; 8192];
    let mut m = 0usize;
    while m < 8192 {
        if (m as u16).count_ones() >= 5 {
            let sh = straight_high_plus1(m as u16);
            t[m] = if sh != 0 {
                (CAT_STRAIGHT_FLUSH << CAT_SHIFT) | ((sh - 1) << 16)
            } else {
                (CAT_FLUSH << CAT_SHIFT) | top_n(m as u16, 5)
            };
        }
        m += 1;
    }
    t
}

/// Straight lookup keyed by a 13-bit rank mask.
static STRAIGHT_HIGH: [u8; 8192] = build_straight_table();

/// Flush lookup keyed by the 13-bit rank mask of a single suit. Entries for
/// masks with fewer than five cards are 0, which loses every comparison.
static FLUSH_LUT: [u32; 8192] = build_flush_table();

// ---------------------------------------------------------------------------
// Fast path
// ---------------------------------------------------------------------------

/// Scores the non-flush categories from rank-multiplicity masks, where `mN`
/// holds the ranks appearing at least `N` times.
#[inline(always)]
fn eval_ranks(m1: u16, m2: u16, m3: u16, m4: u16) -> u32 {
    if m4 != 0 {
        let q = high_bit(m4);
        let k = high_bit(m1 & !(1u16 << q));
        return (CAT_QUADS << CAT_SHIFT) | (q << 16) | (k << 12);
    }
    if m3 != 0 {
        let t = high_bit(m3);
        // `m3` is a subset of `m2`, so a second pair (or second set) shows up
        // here as any other bit of `m2`.
        let pairs = m2 & !(1u16 << t);
        if pairs != 0 {
            return (CAT_FULL_HOUSE << CAT_SHIFT) | (t << 16) | (high_bit(pairs) << 12);
        }
    }
    let sh = STRAIGHT_HIGH[m1 as usize] as u32;
    if sh != 0 {
        return (CAT_STRAIGHT << CAT_SHIFT) | ((sh - 1) << 16);
    }
    if m3 != 0 {
        let t = high_bit(m3);
        return (CAT_TRIPS << CAT_SHIFT) | (t << 16) | (top_n(m1 & !(1u16 << t), 2) >> 4);
    }
    if m2 != 0 {
        let p1 = high_bit(m2);
        let others = m2 & !(1u16 << p1);
        if others != 0 {
            let p2 = high_bit(others);
            let k = high_bit(m1 & !(1u16 << p1) & !(1u16 << p2));
            return (CAT_TWO_PAIR << CAT_SHIFT) | (p1 << 16) | (p2 << 12) | (k << 8);
        }
        return (CAT_PAIR << CAT_SHIFT) | (p1 << 16) | (top_n(m1 & !(1u16 << p1), 3) >> 4);
    }
    (CAT_HIGH_CARD << CAT_SHIFT) | top_n(m1, 5)
}

/// Shared core for 5- and 7-card hands. `N` is a const generic so the card loop
/// unrolls and nothing is heap-allocated.
#[inline(always)]
fn eval_n<const N: usize>(cards: &[Card; N]) -> u32 {
    let mut suit_masks = [0u16; 4];
    let (mut m1, mut m2, mut m3, mut m4) = (0u16, 0u16, 0u16, 0u16);
    let mut i = 0;
    while i < N {
        let c = cards[i];
        debug_assert!((c as usize) < crate::cards::NUM_CARDS, "card out of range");
        let b = 1u16 << (c >> 2);
        suit_masks[(c & 3) as usize] |= b;
        // Carry chain: a bit reaches `mK` once the rank has been seen K times.
        m4 |= m3 & b;
        m3 |= m2 & b;
        m2 |= m1 & b;
        m1 |= b;
        i += 1;
    }

    let mut best = eval_ranks(m1, m2, m3, m4);
    // At most one suit can hold five of seven cards, so the first hit is the
    // only one. Quads and full houses are impossible alongside a seven-card
    // flush, but taking the max keeps this correct without relying on that.
    let mut s = 0;
    while s < 4 {
        if suit_masks[s].count_ones() >= 5 {
            let fv = FLUSH_LUT[suit_masks[s] as usize];
            if fv > best {
                best = fv;
            }
            break;
        }
        s += 1;
    }
    best
}

/// Scores the best five-card hand out of seven cards. Higher is better; equal
/// hands compare exactly equal. Cards must be distinct and in `0..52`.
#[inline]
pub fn eval7(cards: &[Card; 7]) -> u32 {
    eval_n(cards)
}

/// Scores a five-card hand. Values are directly comparable with [`eval7`].
/// Cards must be distinct and in `0..52`.
#[inline]
pub fn eval5(cards: &[Card; 5]) -> u32 {
    eval_n(cards)
}

// ---------------------------------------------------------------------------
// Slow reference
// ---------------------------------------------------------------------------

pub mod reference {
    //! Obviously correct but slow evaluator, kept as the oracle the fast path
    //! is verified against. It returns the identical encoding, so later phases
    //! can assert equality rather than merely equal ordering.

    use super::{
        CAT_FLUSH, CAT_FULL_HOUSE, CAT_HIGH_CARD, CAT_PAIR, CAT_QUADS, CAT_SHIFT, CAT_STRAIGHT,
        CAT_STRAIGHT_FLUSH, CAT_TRIPS, CAT_TWO_PAIR,
    };
    use crate::cards::{rank, suit, Card};

    /// Packs the ranks of `groups` (already ordered best-first) into the
    /// tiebreak field.
    fn pack(groups: &[(u8, u8)]) -> u32 {
        let mut v = 0u32;
        for (i, &(_, r)) in groups.iter().take(5).enumerate() {
            v |= (r as u32) << (16 - 4 * i);
        }
        v
    }

    /// Scores a five-card hand by counting ranks and suits directly.
    pub fn eval5(cards: &[Card; 5]) -> u32 {
        let mut counts = [0u8; 13];
        let mut suit_counts = [0u8; 4];
        for &c in cards {
            counts[rank(c) as usize] += 1;
            suit_counts[suit(c) as usize] += 1;
        }
        let is_flush = suit_counts.iter().any(|&n| n == 5);

        // Ranks ordered by multiplicity, then by rank; both descending. This is
        // exactly the tiebreak order for every paired category.
        let mut groups: Vec<(u8, u8)> = (0..13u8)
            .filter(|&r| counts[r as usize] > 0)
            .map(|r| (counts[r as usize], r))
            .collect();
        groups.sort_unstable_by(|a, b| b.cmp(a));

        let distinct: Vec<u8> = (0..13u8)
            .rev()
            .filter(|&r| counts[r as usize] > 0)
            .collect();
        let straight_high = if distinct.len() != 5 {
            None
        } else if distinct[0] - distinct[4] == 4 {
            Some(distinct[0] as u32)
        } else if distinct[..] == [12, 3, 2, 1, 0] {
            Some(3) // the wheel plays as a five-high straight
        } else {
            None
        };

        let pattern: Vec<u8> = groups.iter().map(|&(n, _)| n).collect();
        let g = |i: usize| groups[i].1 as u32;

        match (is_flush, straight_high, pattern.as_slice()) {
            (true, Some(h), _) => (CAT_STRAIGHT_FLUSH << CAT_SHIFT) | (h << 16),
            (_, _, [4, 1]) => (CAT_QUADS << CAT_SHIFT) | (g(0) << 16) | (g(1) << 12),
            (_, _, [3, 2]) => (CAT_FULL_HOUSE << CAT_SHIFT) | (g(0) << 16) | (g(1) << 12),
            (true, None, _) => (CAT_FLUSH << CAT_SHIFT) | pack(&groups),
            (false, Some(h), _) => (CAT_STRAIGHT << CAT_SHIFT) | (h << 16),
            (_, _, [3, 1, 1]) => {
                (CAT_TRIPS << CAT_SHIFT) | (g(0) << 16) | (g(1) << 12) | (g(2) << 8)
            }
            (_, _, [2, 2, 1]) => {
                (CAT_TWO_PAIR << CAT_SHIFT) | (g(0) << 16) | (g(1) << 12) | (g(2) << 8)
            }
            (_, _, [2, 1, 1, 1]) => {
                (CAT_PAIR << CAT_SHIFT)
                    | (g(0) << 16)
                    | (g(1) << 12)
                    | (g(2) << 8)
                    | (g(3) << 4)
            }
            _ => (CAT_HIGH_CARD << CAT_SHIFT) | pack(&groups),
        }
    }

    /// Best of all 21 five-card subsets of seven cards.
    pub fn eval7(cards: &[Card; 7]) -> u32 {
        let mut best = 0;
        for i in 0..7 {
            for j in (i + 1)..7 {
                let mut five = [0u8; 5];
                let mut n = 0;
                for k in 0..7 {
                    if k != i && k != j {
                        five[n] = cards[k];
                        n += 1;
                    }
                }
                let v = eval5(&five);
                if v > best {
                    best = v;
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_cards;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};
    use std::time::Instant;

    fn h7(s: &str) -> [Card; 7] {
        let v = parse_cards(s).expect("test hand parses");
        assert_eq!(v.len(), 7, "expected 7 cards in {s:?}");
        let mut out = [0u8; 7];
        out.copy_from_slice(&v);
        out
    }

    fn h5(s: &str) -> [Card; 5] {
        let v = parse_cards(s).expect("test hand parses");
        assert_eq!(v.len(), 5, "expected 5 cards in {s:?}");
        let mut out = [0u8; 5];
        out.copy_from_slice(&v);
        out
    }

    fn deal7(rng: &mut StdRng, deck: &mut [Card; 52]) -> [Card; 7] {
        let mut out = [0u8; 7];
        for i in 0..7 {
            let j = rng.gen_range(i..52);
            deck.swap(i, j);
            out[i] = deck[i];
        }
        out
    }

    /// Compares the fast path against the reference on `count` random hands.
    /// Returns (mismatches, first mismatch description, elapsed).
    fn cross_check(seed: u64, count: usize) -> (usize, Option<String>, std::time::Duration) {
        let mut rng = StdRng::seed_from_u64(seed);
        let mut deck: [Card; 52] = std::array::from_fn(|i| i as u8);
        let mut mismatches = 0usize;
        let mut first: Option<String> = None;
        let start = Instant::now();
        for _ in 0..count {
            let hand = deal7(&mut rng, &mut deck);
            let fast = eval7(&hand);
            let slow = reference::eval7(&hand);
            if fast != slow {
                mismatches += 1;
                if first.is_none() {
                    first = Some(format!(
                        "{} -> fast {fast:#x} ({}) vs reference {slow:#x} ({})",
                        crate::cards::cards_to_string(&hand),
                        hand_category(fast),
                        hand_category(slow),
                    ));
                }
            }
        }
        (mismatches, first, start.elapsed())
    }

    #[test]
    fn verify_20k_random_vs_reference() {
        let (mismatches, first, _) = cross_check(0xC0FFEE, 20_000);
        assert_eq!(mismatches, 0, "first mismatch: {}", first.unwrap_or_default());
    }

    /// Full-strength cross-check. Ignored because it takes minutes in debug;
    /// run it explicitly in release:
    /// `cargo test -p engine --release verify_1m -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn verify_1m_random_vs_reference() {
        let count = 1_000_000;
        let (mismatches, first, elapsed) = cross_check(0x5EED_1234_ABCD, count);
        println!("verify_1m_random_vs_reference: {count} hands in {elapsed:?}, {mismatches} mismatches");
        assert_eq!(mismatches, 0, "first mismatch: {}", first.unwrap_or_default());
    }

    /// Exhaustive check of `eval5` over all C(52,5) = 2,598,960 hands. Ignored
    /// for the same reason; run in release:
    /// `cargo test -p engine --release verify_all_five -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn verify_all_five_card_hands_vs_reference() {
        let start = Instant::now();
        let mut checked = 0usize;
        let mut mismatches = 0usize;
        for a in 0..52u8 {
            for b in (a + 1)..52 {
                for c in (b + 1)..52 {
                    for d in (c + 1)..52 {
                        for e in (d + 1)..52 {
                            let hand = [a, b, c, d, e];
                            checked += 1;
                            if eval5(&hand) != reference::eval5(&hand) {
                                mismatches += 1;
                            }
                        }
                    }
                }
            }
        }
        println!(
            "verify_all_five_card_hands_vs_reference: {checked} hands in {:?}, {mismatches} mismatches",
            start.elapsed()
        );
        assert_eq!(checked, 2_598_960);
        assert_eq!(mismatches, 0);
    }

    #[test]
    fn wheel_straight() {
        let wheel = eval7(&h7("Ac 2d 3h 4s 5c Kd Qh"));
        assert_eq!(hand_category(wheel), "straight");
        // The wheel is the lowest straight: a six-high straight beats it.
        let six_high = eval7(&h7("2c 3d 4h 5s 6c Kd Qh"));
        assert_eq!(hand_category(six_high), "straight");
        assert!(six_high > wheel, "{six_high:#x} !> {wheel:#x}");
        // ...and it must beat every non-straight hand of the same cards' class.
        assert!(wheel > eval7(&h7("Ac Ad Kh Ks Qc 7d 3h")));
    }

    #[test]
    fn broadway_is_the_best_straight() {
        let broadway = eval7(&h7("Ac Kd Qh Js Tc 2d 3h"));
        assert_eq!(hand_category(broadway), "straight");
        for lower in ["Kc Qd Jh Ts 9c 2d 3h", "9c 8d 7h 6s 5c 2d 3h", "Ac 2d 3h 4s 5c 8d 9h"] {
            assert!(broadway > eval7(&h7(lower)), "broadway !> {lower}");
        }
    }

    #[test]
    fn flush_beats_straight() {
        let flush = eval7(&h7("2c 5c 7c 9c Jc 3d 4h"));
        let straight = eval7(&h7("9c 8d 7h 6s 5c Ad Kh"));
        assert_eq!(hand_category(flush), "flush");
        assert_eq!(hand_category(straight), "straight");
        assert!(flush > straight);
    }

    #[test]
    fn full_house_beats_flush() {
        let boat = eval7(&h7("7c 7d 7h 4s 4c Ad Kh"));
        let flush = eval7(&h7("Ac Kc 9c 5c 2c 3d 4h"));
        assert_eq!(hand_category(boat), "full house");
        assert_eq!(hand_category(flush), "flush");
        assert!(boat > flush);
        // Boat tiebreak: trips rank dominates the pair rank.
        assert!(eval7(&h7("8c 8d 8h 2s 2c Ad Kh")) > eval7(&h7("7c 7d 7h As Ac 4d 3h")));
    }

    #[test]
    fn quads_beat_full_house_and_rank_by_kicker() {
        let quads = eval7(&h7("9c 9d 9h 9s 2c 3d 4h"));
        let boat = eval7(&h7("Ac Ad Ah Ks Kc 4d 3h"));
        assert_eq!(hand_category(quads), "quads");
        assert!(quads > boat);
        // Same quads, better kicker wins.
        assert!(eval7(&h7("9c 9d 9h 9s Ac 3d 4h")) > eval7(&h7("9c 9d 9h 9s Kc 3d 4h")));
        // Quads with two spare cards: only the best kicker counts.
        assert_eq!(
            eval7(&h7("9c 9d 9h 9s Ac 3d 4h")),
            eval7(&h7("9c 9d 9h 9s Ac 2d 5h"))
        );
    }

    #[test]
    fn straight_flush_tops_everything() {
        let sf = eval7(&h7("5h 6h 7h 8h 9h As Ad"));
        assert_eq!(hand_category(sf), "straight flush");
        assert!(sf > eval7(&h7("9c 9d 9h 9s Ac 3d 4h")));
        let royal = eval7(&h7("Th Jh Qh Kh Ah 2c 3d"));
        assert_eq!(hand_category(royal), "straight flush");
        assert!(royal > sf);
        // Steel wheel is the weakest straight flush but still beats quads.
        let steel = eval7(&h7("Ah 2h 3h 4h 5h Kd Qc"));
        assert_eq!(hand_category(steel), "straight flush");
        assert!(steel < sf);
        assert!(steel > eval7(&h7("9c 9d 9h 9s Ac 3d 4h")));
    }

    #[test]
    fn board_plays_gives_exact_ties() {
        // Royal flush board: every pair of hole cards plays the board.
        let a = eval7(&h7("As Ks Qs Js Ts 2c 3d"));
        let b = eval7(&h7("As Ks Qs Js Ts 4h 5h"));
        assert_eq!(a, b);
        assert_eq!(hand_category(a), "straight flush");

        // Quad deuces with an ace kicker on board: nothing below an ace helps.
        let c = eval7(&h7("2c 2d 2h 2s Ah Kd Qc"));
        let d = eval7(&h7("2c 2d 2h 2s Ah 7s 8s"));
        assert_eq!(c, d);
        assert_eq!(hand_category(c), "quads");
    }

    #[test]
    fn eval5_matches_eval7_when_the_board_plays() {
        let board = h5("As Ks Qs Js Ts");
        assert_eq!(eval5(&board), eval7(&h7("As Ks Qs Js Ts 2c 3d")));
        let board = h5("2c 2d 2h 2s Ah");
        assert_eq!(eval5(&board), eval7(&h7("2c 2d 2h 2s Ah 7s 8s")));
    }

    #[test]
    fn category_ladder_is_ordered() {
        let ladder = [
            ("Ac Kd 9h 7s 5c 3d 2h", "high card"),
            ("Ac Ad 9h 7s 5c 3d 2h", "pair"),
            ("Ac Ad 9h 9s 5c 3d 2h", "two pair"),
            ("Ac Ad Ah 9s 5c 3d 2h", "trips"),
            ("9c 8d 7h 6s 5c Ad 2h", "straight"),
            ("Ac Kc 9c 7c 5c 3d 2h", "flush"),
            ("Ac Ad Ah 9s 9c 3d 2h", "full house"),
            ("Ac Ad Ah As 9c 3d 2h", "quads"),
            ("9c 8c 7c 6c 5c Ad 2h", "straight flush"),
        ];
        let mut prev = 0;
        for (cards, name) in ladder {
            let v = eval7(&h7(cards));
            assert_eq!(hand_category(v), name, "{cards}");
            assert!(v > prev, "{name} ({v:#x}) did not beat the previous rung");
            prev = v;
        }
    }

    #[test]
    fn hand_category_rejects_impossible_values() {
        assert_eq!(hand_category(u32::MAX), "unknown");
    }
}
