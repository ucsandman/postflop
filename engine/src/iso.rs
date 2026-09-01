//! Suit isomorphism for flop enumeration.
//!
//! There is no suit ranking in NLHE, so two flops are strategically identical
//! when one can be turned into the other by relabelling suits. The 22100 raw
//! flops (`C(52, 3)`) therefore collapse into 1755 equivalence classes under
//! the 24-element group of suit permutations.
//!
//! # Canonical form
//!
//! Cards are ordered inside this module by *display key*: rank descending, then
//! suit ascending in `c < d < h < s`. `Ac` has key 0, `Ad` 1, `Ah` 2, `As` 3,
//! `Kc` 4, ... `2s` 51.
//!
//! The canonical representative of a flop is, over all 24 suit permutations
//! `p`, the image `p(flop)` whose key triple (the three cards sorted ascending
//! by key) is lexicographically smallest. Ties among permutations that produce
//! that same image are broken by taking the lexicographically smallest `p`
//! written as `[p(c), p(d), p(h), p(s)]`, so a flop that is already canonical
//! always reports the identity permutation `[0, 1, 2, 3]`.
//!
//! Read informally: take the flop in rank-descending order and relabel the
//! suits in first-seen order `c`, `d`, `h`. `Ah Kh 2c` and `As Ks 2d` both
//! canonicalise to `Ac Kc 2d`; `Ah Ac Ks` canonicalises to `Ac Ad Kh`.
//!
//! The returned `[Card; 3]` is always sorted by key (highest rank first). This
//! rule is fixed: downstream aggregate reports index off these representatives.

use std::collections::HashMap;

use crate::cards::{make_card, rank, suit, Card};

/// Suit permutation that changes nothing.
const IDENTITY: [u8; 4] = [0, 1, 2, 3];

/// Display key of a card: rank descending, then suit ascending.
/// `Ac` = 0, `Ad` = 1, `Ah` = 2, `As` = 3, `Kc` = 4, ... `2s` = 51.
#[inline(always)]
fn order_key(c: Card) -> u8 {
    (12 - rank(c)) * 4 + suit(c)
}

/// Relabels a card's suit through `perm`, which maps `old_suit -> new_suit`.
/// The rank is untouched.
#[inline(always)]
pub fn apply_suit_perm(c: Card, perm: &[u8; 4]) -> Card {
    make_card(rank(c), perm[suit(c) as usize])
}

/// A flop equivalence class: its canonical representative and how many of the
/// 22100 raw flops map onto it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanonicalFlop {
    /// Canonical representative, sorted by display key (highest rank first).
    pub flop: [Card; 3],
    /// Number of raw flops in this class: 4, 12, or 24.
    pub weight: u32,
}

/// Applies `perm` to every card and sorts the image by display key.
fn permuted_sorted(flop: [Card; 3], perm: &[u8; 4]) -> [Card; 3] {
    let mut out = [
        apply_suit_perm(flop[0], perm),
        apply_suit_perm(flop[1], perm),
        apply_suit_perm(flop[2], perm),
    ];
    out.sort_unstable_by_key(|&c| order_key(c));
    out
}

/// Display keys of an already-sorted flop, for lexicographic comparison.
#[inline(always)]
fn keys(flop: &[Card; 3]) -> [u8; 3] {
    [order_key(flop[0]), order_key(flop[1]), order_key(flop[2])]
}

/// Canonicalises a flop by suit permutation.
///
/// Returns the canonical representative (sorted by display key) and the suit
/// permutation `old_suit -> new_suit` that maps the input cards onto it, so
/// that `flop.map(|c| apply_suit_perm(c, &perm))` is the representative as a
/// set. See the module docs for the exact canonical form.
///
/// The three cards must be distinct and in `0..52`; the function never panics
/// on out-of-range input, it just returns garbage in that case.
pub fn canonical_flop(flop: [Card; 3]) -> ([Card; 3], [u8; 4]) {
    debug_assert!(
        flop.iter().all(|&c| (c as usize) < crate::cards::NUM_CARDS)
            && flop[0] != flop[1]
            && flop[0] != flop[2]
            && flop[1] != flop[2],
        "canonical_flop needs three distinct cards in 0..52"
    );

    // Identity is the lexicographically smallest permutation, so seeding with it
    // makes an already-canonical flop report `IDENTITY`.
    let mut best = (permuted_sorted(flop, &IDENTITY), IDENTITY);
    let mut best_keys = keys(&best.0);

    // All 24 permutations of [0,1,2,3], generated in lexicographic order.
    for a in 0..4u8 {
        for b in 0..4u8 {
            if b == a {
                continue;
            }
            for c in 0..4u8 {
                if c == a || c == b {
                    continue;
                }
                let perm = [a, b, c, 6 - a - b - c];
                let cand = permuted_sorted(flop, &perm);
                let cand_keys = keys(&cand);
                if cand_keys < best_keys {
                    best = (cand, perm);
                    best_keys = cand_keys;
                }
            }
        }
    }
    best
}

/// Enumerates every flop equivalence class.
///
/// Walks all 22100 raw flops, canonicalises each, and returns the 1755 classes
/// sorted by the representative's display key (`Ac Kc Qc` first, `4s 3s 2s`
/// last). The weights sum to 22100.
pub fn all_canonical_flops() -> Vec<CanonicalFlop> {
    let n = crate::cards::NUM_CARDS as u8;
    let mut counts: HashMap<[Card; 3], u32> = HashMap::with_capacity(2048);
    for a in 0..n {
        for b in (a + 1)..n {
            for c in (b + 1)..n {
                *counts.entry(canonical_flop([a, b, c]).0).or_insert(0) += 1;
            }
        }
    }
    let mut out: Vec<CanonicalFlop> = counts
        .into_iter()
        .map(|(flop, weight)| CanonicalFlop { flop, weight })
        .collect();
    out.sort_unstable_by_key(|cf| keys(&cf.flop));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{cards_to_string, parse_cards, NUM_CARDS};

    fn flop_of(s: &str) -> [Card; 3] {
        let v = parse_cards(s).expect("test flop parses");
        [v[0], v[1], v[2]]
    }

    fn all_raw_flops() -> Vec<[Card; 3]> {
        let n = NUM_CARDS as u8;
        let mut v = Vec::with_capacity(22100);
        for a in 0..n {
            for b in (a + 1)..n {
                for c in (b + 1)..n {
                    v.push([a, b, c]);
                }
            }
        }
        v
    }

    fn num_suits(flop: &[Card; 3]) -> usize {
        let mut m = 0u8;
        for &c in flop {
            m |= 1 << suit(c);
        }
        m.count_ones() as usize
    }

    #[test]
    fn raw_flop_count_is_22100() {
        assert_eq!(all_raw_flops().len(), 22100);
    }

    #[test]
    fn exactly_1755_classes() {
        assert_eq!(all_canonical_flops().len(), 1755);
    }

    #[test]
    fn weights_sum_to_22100() {
        let classes = all_canonical_flops();
        let total: u32 = classes.iter().map(|c| c.weight).sum();
        assert_eq!(total, 22100);
        // Only three orbit sizes are possible under S4 acting on flops.
        for c in &classes {
            assert!(
                matches!(c.weight, 4 | 12 | 24),
                "unexpected weight {} for {}",
                c.weight,
                cards_to_string(&c.flop)
            );
        }
    }

    #[test]
    fn representatives_are_fixed_points() {
        for c in all_canonical_flops() {
            let (rep, perm) = canonical_flop(c.flop);
            assert_eq!(rep, c.flop, "{} is not its own rep", cards_to_string(&c.flop));
            assert_eq!(
                perm,
                IDENTITY,
                "{} canonicalises with a non-identity perm",
                cards_to_string(&c.flop)
            );
        }
    }

    #[test]
    fn returned_perm_maps_every_flop_onto_its_rep() {
        for flop in all_raw_flops() {
            let (rep, perm) = canonical_flop(flop);

            // perm must be a genuine permutation of the four suits.
            let mut seen = [false; 4];
            for &s in &perm {
                assert!(s < 4, "perm {perm:?} out of range");
                assert!(!seen[s as usize], "perm {perm:?} is not a bijection");
                seen[s as usize] = true;
            }

            let mut image = flop.map(|c| apply_suit_perm(c, &perm));
            image.sort_unstable();
            let mut expect = rep;
            expect.sort_unstable();
            assert_eq!(
                image,
                expect,
                "{} + {:?} did not land on {}",
                cards_to_string(&flop),
                perm,
                cards_to_string(&rep)
            );

            // Ranks are never touched, and the rep really is in the class.
            let mut in_ranks: Vec<u8> = flop.iter().map(|&c| rank(c)).collect();
            let mut out_ranks: Vec<u8> = rep.iter().map(|&c| rank(c)).collect();
            in_ranks.sort_unstable();
            out_ranks.sort_unstable();
            assert_eq!(in_ranks, out_ranks);
        }
    }

    #[test]
    fn known_isomorphic_flops_share_a_rep() {
        let (a, _) = canonical_flop(flop_of("Ah Kh 2c"));
        let (b, _) = canonical_flop(flop_of("As Ks 2d"));
        assert_eq!(a, b);
        // Pins the canonical rule itself, not just agreement.
        assert_eq!(cards_to_string(&a), "Ac Kc 2d");
        // Order of the input cards must not matter.
        assert_eq!(canonical_flop(flop_of("2c Kh Ah")).0, a);

        // Paired flop: first-seen relabelling in rank-descending order.
        assert_eq!(cards_to_string(&canonical_flop(flop_of("Ah Ac Ks")).0), "Ac Ad Kh");
        // Monotone and rainbow anchors.
        assert_eq!(cards_to_string(&canonical_flop(flop_of("7s 5s 2s")).0), "7c 5c 2c");
        assert_eq!(cards_to_string(&canonical_flop(flop_of("Th 9s 8d")).0), "Tc 9d 8h");
    }

    #[test]
    fn non_isomorphic_flops_stay_apart() {
        // Same ranks, different suit pattern (two-tone vs rainbow).
        let two_tone = canonical_flop(flop_of("Ah Kh Qs")).0;
        let rainbow = canonical_flop(flop_of("Ah Kd Qs")).0;
        assert_ne!(two_tone, rainbow);
        // Which card carries the odd suit matters.
        assert_ne!(
            canonical_flop(flop_of("Ah Kh Qs")).0,
            canonical_flop(flop_of("Ah Ks Qh")).0
        );
    }

    #[test]
    fn suit_pattern_counts_are_stable() {
        // Computed from this enumeration; cross-checked by hand:
        //   monotone  = C(13,3)            = 286 classes, 4 flops each   =  1144
        //   two-tone  = C(13,2) * 13       = 1014 classes, 12 flops each = 12168
        //   rainbow   = C(15,3) multisets  = 455 classes                 =  8788
        let mut classes = [0u32; 4];
        let mut raw = [0u32; 4];
        for c in all_canonical_flops() {
            classes[num_suits(&c.flop)] += 1;
            raw[num_suits(&c.flop)] += c.weight;
        }
        assert_eq!((classes[1], raw[1]), (286, 1144), "monotone");
        assert_eq!((classes[2], raw[2]), (1014, 12168), "two-tone");
        assert_eq!((classes[3], raw[3]), (455, 8788), "rainbow");
        assert_eq!(classes[1] + classes[2] + classes[3], 1755);
        assert_eq!(raw[1] + raw[2] + raw[3], 22100);

        // The suit pattern is an invariant of the class, checked on raw flops.
        for flop in all_raw_flops() {
            assert_eq!(num_suits(&flop), num_suits(&canonical_flop(flop).0));
        }
    }

    #[test]
    fn apply_suit_perm_permutes_the_deck() {
        let perm = [2u8, 0, 3, 1];
        let mut seen = [false; NUM_CARDS];
        for c in 0..NUM_CARDS as u8 {
            let out = apply_suit_perm(c, &perm);
            assert_eq!(rank(out), rank(c));
            assert_eq!(suit(out), perm[suit(c) as usize]);
            assert!(!seen[out as usize]);
            seen[out as usize] = true;
        }
        assert!(seen.iter().all(|&b| b));
        for c in 0..NUM_CARDS as u8 {
            assert_eq!(apply_suit_perm(c, &IDENTITY), c);
        }
    }
}
