//! Hole-card ranges over the 1326 unordered two-card combos, with parsing of
//! standard/PioSOLVER-style range notation and board-based combo filtering.
//!
//! # Canonical combo ordering
//! Every unordered pair of distinct [`Card`]s has a canonical index in
//! `0..NUM_COMBOS`. Cards are compared by their raw `u8` value (`rank*4 +
//! suit`); for a pair `(lo, hi)` with `lo < hi`, combos are ordered first by
//! `lo` ascending, then by `hi` ascending. This is the ordering
//! [`Range::live_on`] preserves in its output, and is the canonical
//! per-street combo ordering downstream solver code should rely on.

use crate::cards::{make_card, mask_of, parse_card, Card, NUM_CARDS};

/// Number of unordered two-card combos from a 52-card deck: `C(52, 2)`.
pub const NUM_COMBOS: usize = 1326;

/// Row offset (in the canonical ordering) of the first combo whose lower
/// card is `lo`. `lo * (NUM_CARDS - 1) - lo*(lo-1)/2`, rewritten to avoid
/// unsigned underflow at `lo == 0`.
fn row_start(lo: usize) -> usize {
    let n1 = NUM_CARDS - 1;
    lo * n1 - (lo * lo - lo) / 2
}

/// Canonical 1326-combo index for an unordered pair of distinct cards.
///
/// Order-insensitive: `combo_index(a, b) == combo_index(b, a)`.
pub fn combo_index(a: Card, b: Card) -> usize {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    debug_assert!((hi as usize) < NUM_CARDS && lo < hi, "combo_index requires two distinct cards");
    let (lo, hi) = (lo as usize, hi as usize);
    row_start(lo) + (hi - lo - 1)
}

/// Inverse of [`combo_index`]: the two cards for a canonical combo index,
/// returned as `(lo, hi)` with `lo < hi`.
pub fn combo_cards(idx: usize) -> (Card, Card) {
    debug_assert!(idx < NUM_COMBOS, "combo index out of range: {idx}");
    let mut lo = 0usize;
    while row_start(lo + 1) <= idx {
        lo += 1;
    }
    let hi = idx - row_start(lo) + lo + 1;
    (lo as Card, hi as Card)
}

/// A parsed shape before it's expanded to concrete cards: a pair, a
/// suited/offsuit/either hand keyed by (high rank, low rank), or one
/// explicit combo.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BaseShape {
    Pair(u8),
    Suited(u8, u8),
    Offsuit(u8, u8),
    Both(u8, u8),
    Explicit(Card, Card),
}

fn parse_rank_char(c: char) -> Result<u8, String> {
    crate::cards::RANK_CHARS
        .iter()
        .position(|&r| r == c.to_ascii_uppercase())
        .map(|p| p as u8)
        .ok_or_else(|| format!("unknown rank {c:?}"))
}

/// Parses one base token: a pair (`AA`), suited/offsuit hand (`AKs`,
/// `QJo`), unpaired hand meaning both (`AK`), or an explicit combo
/// (`AhKh`).
fn parse_base(tok: &str) -> Result<BaseShape, String> {
    let t = tok.trim();
    if t.len() == 4 {
        if let (Ok(c1), Ok(c2)) = (parse_card(&t[0..2]), parse_card(&t[2..4])) {
            if c1 == c2 {
                return Err(format!("{tok:?}: explicit combo repeats the same card"));
            }
            return Ok(BaseShape::Explicit(c1, c2));
        }
    }
    let chars: Vec<char> = t.chars().collect();
    match chars.len() {
        2 => {
            let r1 = parse_rank_char(chars[0])?;
            let r2 = parse_rank_char(chars[1])?;
            if r1 == r2 {
                Ok(BaseShape::Pair(r1))
            } else {
                let (hi, lo) = if r1 > r2 { (r1, r2) } else { (r2, r1) };
                Ok(BaseShape::Both(hi, lo))
            }
        }
        3 => {
            let r1 = parse_rank_char(chars[0])?;
            let r2 = parse_rank_char(chars[1])?;
            if r1 == r2 {
                return Err(format!("{tok:?}: a pair cannot take an s/o suffix"));
            }
            let (hi, lo) = if r1 > r2 { (r1, r2) } else { (r2, r1) };
            match chars[2].to_ascii_lowercase() {
                's' => Ok(BaseShape::Suited(hi, lo)),
                'o' => Ok(BaseShape::Offsuit(hi, lo)),
                other => Err(format!("{tok:?}: expected suffix 's' or 'o', found {other:?}")),
            }
        }
        _ => Err(format!("{tok:?}: unrecognized range token")),
    }
}

/// Every concrete `(Card, Card)` combo a shape expands to.
fn shape_combos(shape: BaseShape) -> Vec<(Card, Card)> {
    match shape {
        BaseShape::Pair(r) => {
            let mut v = Vec::with_capacity(6);
            for s1 in 0..4u8 {
                for s2 in (s1 + 1)..4u8 {
                    v.push((make_card(r, s1), make_card(r, s2)));
                }
            }
            v
        }
        BaseShape::Suited(hi, lo) => (0..4u8).map(|s| (make_card(hi, s), make_card(lo, s))).collect(),
        BaseShape::Offsuit(hi, lo) => {
            let mut v = Vec::with_capacity(12);
            for s1 in 0..4u8 {
                for s2 in 0..4u8 {
                    if s1 != s2 {
                        v.push((make_card(hi, s1), make_card(lo, s2)));
                    }
                }
            }
            v
        }
        BaseShape::Both(hi, lo) => {
            let mut v = shape_combos(BaseShape::Suited(hi, lo));
            v.extend(shape_combos(BaseShape::Offsuit(hi, lo)));
            v
        }
        BaseShape::Explicit(a, b) => vec![(a, b)],
    }
}

/// Expands a `+` plus-range: for pairs, sweeps the pair rank up to the ace;
/// for suited/offsuit/unpaired hands, sweeps the low rank up to one below
/// the (fixed) high rank.
fn expand_plus(shape: BaseShape) -> Result<Vec<BaseShape>, String> {
    const ACE: u8 = 12;
    Ok(match shape {
        BaseShape::Pair(r) => (r..=ACE).map(BaseShape::Pair).collect(),
        BaseShape::Suited(hi, lo) => (lo..hi).map(|l| BaseShape::Suited(hi, l)).collect(),
        BaseShape::Offsuit(hi, lo) => (lo..hi).map(|l| BaseShape::Offsuit(hi, l)).collect(),
        BaseShape::Both(hi, lo) => (lo..hi).map(|l| BaseShape::Both(hi, l)).collect(),
        BaseShape::Explicit(..) => return Err("'+' is not valid on an explicit combo".to_string()),
    })
}

fn same_kind(a: BaseShape, b: BaseShape) -> bool {
    matches!(
        (a, b),
        (BaseShape::Pair(_), BaseShape::Pair(_))
            | (BaseShape::Suited(..), BaseShape::Suited(..))
            | (BaseShape::Offsuit(..), BaseShape::Offsuit(..))
            | (BaseShape::Both(..), BaseShape::Both(..))
    )
}

fn hi_lo(shape: BaseShape) -> Option<(u8, u8)> {
    match shape {
        BaseShape::Pair(r) => Some((r, r)),
        BaseShape::Suited(hi, lo) | BaseShape::Offsuit(hi, lo) | BaseShape::Both(hi, lo) => Some((hi, lo)),
        BaseShape::Explicit(..) => None,
    }
}

fn rebuild(kind_like: BaseShape, hi: u8, lo: u8) -> BaseShape {
    match kind_like {
        BaseShape::Pair(_) => BaseShape::Pair(hi),
        BaseShape::Suited(..) => BaseShape::Suited(hi, lo),
        BaseShape::Offsuit(..) => BaseShape::Offsuit(hi, lo),
        BaseShape::Both(..) => BaseShape::Both(hi, lo),
        BaseShape::Explicit(..) => unreachable!("filtered out by hi_lo"),
    }
}

/// Expands a `X-Y` dash-range between two same-kind base shapes: pairs
/// sweep the pair rank between the two ranks; hands sharing the same high
/// rank sweep the low rank (`A5s-A2s`); hands with the same rank gap sweep
/// both ranks together, connector-style (`76s-54s`).
fn expand_dash(s1: BaseShape, s2: BaseShape, raw: &str) -> Result<Vec<BaseShape>, String> {
    if !same_kind(s1, s2) {
        return Err(format!(
            "{raw:?}: dash-range endpoints must be the same kind (pair/suited/offsuit/unpaired)"
        ));
    }
    let (hi1, lo1) = hi_lo(s1).ok_or_else(|| format!("{raw:?}: dash-range not supported on explicit combos"))?;
    let (hi2, lo2) = hi_lo(s2).unwrap();
    let minmax = |a: u8, b: u8| if a <= b { (a, b) } else { (b, a) };

    let mut out = Vec::new();
    if matches!(s1, BaseShape::Pair(_)) {
        let (from, to) = minmax(hi1, hi2);
        for r in from..=to {
            out.push(BaseShape::Pair(r));
        }
    } else if hi1 == hi2 {
        let (from, to) = minmax(lo1, lo2);
        for lo in from..=to {
            out.push(rebuild(s1, hi1, lo));
        }
    } else if hi1 - lo1 == hi2 - lo2 {
        let gap = hi1 - lo1;
        let (from, to) = minmax(hi1, hi2);
        for hi in from..=to {
            out.push(rebuild(s1, hi, hi - gap));
        }
    } else {
        return Err(format!("{raw:?}: ambiguous dash-range, ranks don't align"));
    }
    Ok(out)
}

/// Parses a single (non-comma, non-weight) range token into the shapes it
/// expands to: a `+` plus-range, a `-` dash-range, or one base shape.
fn parse_shapes(body: &str) -> Result<Vec<BaseShape>, String> {
    if let Some(prefix) = body.strip_suffix('+') {
        expand_plus(parse_base(prefix)?)
    } else if let Some(dash_pos) = body.find('-') {
        let (left, right) = body.split_at(dash_pos);
        let s1 = parse_base(left)?;
        let s2 = parse_base(&right[1..])?;
        expand_dash(s1, s2, body)
    } else {
        Ok(vec![parse_base(body)?])
    }
}

/// A hole-card range: a weight in `0.0..=1.0` for each of the 1326
/// canonical combos (see the [module docs](self) for the ordering).
#[derive(Clone, Debug)]
pub struct Range {
    weights: [f32; NUM_COMBOS],
}

impl Range {
    /// The full 1326-combo range, every combo at weight `1.0`.
    pub fn uniform_full() -> Range {
        Range { weights: [1.0; NUM_COMBOS] }
    }

    /// Parses standard/PioSOLVER-style range notation: comma-separated
    /// tokens, each a pair (`AA`), suited (`AKs`), offsuit (`QJo`),
    /// unpaired meaning both (`AK` = `AKs`+`AKo`), a `+` plus-range
    /// (`TT+`, `ATs+`), a `-` dash-range (`A5s-A2s`, `99-66`), or an
    /// explicit combo (`AhKh`) - each optionally weighted with a trailing
    /// `:weight` (e.g. `AKs:0.5`), defaulting to weight `1.0`.
    ///
    /// Combos not named by any token stay at weight `0.0`. When two tokens
    /// name the same combo, the later token's weight wins (assignment, not
    /// accumulation). Whitespace around tokens and the `:weight` split is
    /// ignored. Malformed tokens are rejected with an error naming the
    /// token.
    pub fn parse(s: &str) -> Result<Range, String> {
        let mut weights = [0.0f32; NUM_COMBOS];
        for raw_token in s.split(',') {
            let tok = raw_token.trim();
            if tok.is_empty() {
                continue;
            }
            let (shape_part, weight) = match tok.rsplit_once(':') {
                Some((shape, w)) => {
                    let w: f32 = w
                        .trim()
                        .parse()
                        .map_err(|_| format!("{tok:?}: invalid weight {w:?}"))?;
                    if !(0.0..=1.0).contains(&w) {
                        return Err(format!("{tok:?}: weight must be within 0.0..=1.0"));
                    }
                    (shape.trim(), w)
                }
                None => (tok, 1.0f32),
            };
            let shapes = parse_shapes(shape_part).map_err(|e| format!("{tok:?}: {e}"))?;
            for shape in shapes {
                for (a, b) in shape_combos(shape) {
                    weights[combo_index(a, b)] = weight;
                }
            }
        }
        Ok(Range { weights })
    }

    /// This combo's weight, by canonical index (see [`combo_index`]).
    pub fn weight(&self, idx: usize) -> f32 {
        self.weights[idx]
    }

    /// All 1326 weights, indexed by canonical combo index.
    pub fn weights(&self) -> &[f32] {
        &self.weights
    }

    /// Filters this range down to the combos that don't share a card with
    /// `board_mask`. Blocked combos are removed outright (not
    /// zero-weighted); survivors keep their canonical index, ascending.
    pub fn live_on(&self, board_mask: u64) -> LiveRange {
        let mut combos = Vec::new();
        for idx in 0..NUM_COMBOS {
            let (a, b) = combo_cards(idx);
            if mask_of(&[a, b]) & board_mask != 0 {
                continue;
            }
            combos.push(LiveCombo { index: idx, cards: (a, b), weight: self.weights[idx] });
        }
        LiveRange { combos }
    }
}

/// One combo surviving [`Range::live_on`] board filtering.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveCombo {
    /// Canonical index into the full 1326-combo ordering (see [`combo_index`]).
    pub index: usize,
    /// The two cards making up this combo.
    pub cards: (Card, Card),
    /// This combo's weight in the source range.
    pub weight: f32,
}

/// The combos of a [`Range`] that survive filtering against a board,
/// ordered ascending by canonical combo index. This ordering is the
/// canonical per-street combo ordering downstream solver code should use.
#[derive(Clone, Debug)]
pub struct LiveRange {
    pub combos: Vec<LiveCombo>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_cards;

    fn choose2(n: usize) -> usize {
        n * (n.saturating_sub(1)) / 2
    }

    #[test]
    fn combo_index_roundtrip_is_total() {
        for idx in 0..NUM_COMBOS {
            let (a, b) = combo_cards(idx);
            assert!(a < b);
            assert_eq!(combo_index(a, b), idx);
            assert_eq!(combo_index(b, a), idx, "combo_index must be order-insensitive");
        }
    }

    #[test]
    fn pair_parses_to_6_combos() {
        let r = Range::parse("AA").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 6);
    }

    #[test]
    fn suited_parses_to_4_combos() {
        let r = Range::parse("AKs").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 4);
    }

    #[test]
    fn offsuit_parses_to_12_combos() {
        let r = Range::parse("AKo").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 12);
    }

    #[test]
    fn unpaired_without_suffix_parses_to_16_combos() {
        let r = Range::parse("AK").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 16);
    }

    #[test]
    fn pair_plus_range_parses_to_78_combos() {
        let r = Range::parse("22+").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 78);
    }

    #[test]
    fn suited_dash_range_parses_to_16_combos() {
        let r = Range::parse("A5s-A2s").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 16);
    }

    #[test]
    fn connector_dash_range() {
        // 76s-54s -> {76s, 65s, 54s}: 3 suited hands * 4 combos.
        let r = Range::parse("76s-54s").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 12);
    }

    #[test]
    fn pair_dash_range() {
        // 99-66 -> {99,88,77,66}: 4 pairs * 6 combos.
        let r = Range::parse("99-66").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 24);
    }

    #[test]
    fn explicit_combo_parses_to_1_combo() {
        let r = Range::parse("AhKh").unwrap();
        assert_eq!(r.weights().iter().filter(|&&w| w > 0.0).count(), 1);
        let a = parse_card("Ah").unwrap();
        let k = parse_card("Kh").unwrap();
        assert_eq!(r.weight(combo_index(a, k)), 1.0);
    }

    #[test]
    fn weight_parsing_is_exact() {
        let r = Range::parse("AA:0.25, KK:0.75").unwrap();
        let aces = parse_cards("As Ad").unwrap();
        let kings = parse_cards("Ks Kd").unwrap();
        assert_eq!(r.weight(combo_index(aces[0], aces[1])), 0.25);
        assert_eq!(r.weight(combo_index(kings[0], kings[1])), 0.75);
    }

    #[test]
    fn later_token_overrides_earlier() {
        let r = Range::parse("AA:0.9,AA:0.3").unwrap();
        let aces = parse_cards("As Ad").unwrap();
        assert_eq!(r.weight(combo_index(aces[0], aces[1])), 0.3);
    }

    #[test]
    fn malformed_token_is_rejected_with_useful_error() {
        let err = Range::parse("XX").unwrap_err();
        assert!(err.contains("XX"), "error should name the token: {err}");

        let err = Range::parse("AKq").unwrap_err();
        assert!(err.contains("AKq"), "error should name the token: {err}");

        let err = Range::parse("AKs:1.5").unwrap_err();
        assert!(err.contains("AKs:1.5"), "error should name the token: {err}");
    }

    #[test]
    fn full_range_totals_1326_combos_at_weight_1() {
        let r = Range::uniform_full();
        assert_eq!(r.weights().len(), NUM_COMBOS);
        assert!(r.weights().iter().all(|&w| w == 1.0));
    }

    #[test]
    fn live_on_3_card_board_leaves_1176_combos() {
        let board = parse_cards("As Kd Qh").unwrap();
        let live = Range::uniform_full().live_on(mask_of(&board));
        assert_eq!(live.combos.len(), 1176);
        for c in &live.combos {
            assert_eq!(mask_of(&[c.cards.0, c.cards.1]) & mask_of(&board), 0, "blocked combo present");
        }
    }

    #[test]
    fn live_on_4_card_board_leaves_1128_combos() {
        let board = parse_cards("As Kd Qh Jc").unwrap();
        let live = Range::uniform_full().live_on(mask_of(&board));
        assert_eq!(live.combos.len(), 1128);
    }

    #[test]
    fn live_on_5_card_board_leaves_1081_combos() {
        let board = parse_cards("As Kd Qh Jc 9s").unwrap();
        let live = Range::uniform_full().live_on(mask_of(&board));
        assert_eq!(live.combos.len(), 1081);
    }

    #[test]
    fn live_on_ordering_is_ascending_by_canonical_index() {
        let board = parse_cards("As Kd Qh").unwrap();
        let live = Range::uniform_full().live_on(mask_of(&board));
        for w in live.combos.windows(2) {
            assert!(w[0].index < w[1].index);
        }
    }

    #[test]
    fn live_on_count_matches_choose2_for_random_boards() {
        use rand::seq::SliceRandom;
        let full = Range::uniform_full();
        let mut rng = rand::thread_rng();
        let mut deck: Vec<Card> = (0..NUM_CARDS as Card).collect();
        for &n in &[0usize, 1, 2, 3, 4, 5] {
            for _ in 0..50 {
                deck.shuffle(&mut rng);
                let board = &deck[..n];
                let live = full.live_on(mask_of(board));
                assert_eq!(live.combos.len(), choose2(NUM_CARDS - n));
            }
        }
    }
}
