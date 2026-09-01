//! Card primitives. A `Card` is a `u8` in `0..52`, encoded `rank * 4 + suit`.
//! Ranks: 0 = deuce .. 12 = ace. Suits: 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades.

pub type Card = u8;

pub const NUM_CARDS: usize = 52;
pub const RANK_CHARS: [char; 13] = [
    '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
];
pub const SUIT_CHARS: [char; 4] = ['c', 'd', 'h', 's'];

#[inline(always)]
pub fn rank(c: Card) -> u8 {
    c >> 2
}

#[inline(always)]
pub fn suit(c: Card) -> u8 {
    c & 3
}

#[inline(always)]
pub fn make_card(rank: u8, suit: u8) -> Card {
    rank * 4 + suit
}

/// Bitmask with the single bit for this card set (bit index = card value).
#[inline(always)]
pub fn card_mask(c: Card) -> u64 {
    1u64 << c
}

/// Combined mask of a card slice.
pub fn mask_of(cards: &[Card]) -> u64 {
    cards.iter().fold(0u64, |m, &c| m | card_mask(c))
}

pub fn parse_card(s: &str) -> Result<Card, String> {
    let mut chars = s.chars();
    let (Some(rc), Some(sc), None) = (chars.next(), chars.next(), chars.next()) else {
        return Err(format!("bad card {s:?}: expected 2 chars like As"));
    };
    let rank = RANK_CHARS
        .iter()
        .position(|&r| r == rc.to_ascii_uppercase())
        .ok_or_else(|| format!("bad rank {rc:?} in card {s:?}"))? as u8;
    let suit = SUIT_CHARS
        .iter()
        .position(|&x| x == sc.to_ascii_lowercase())
        .ok_or_else(|| format!("bad suit {sc:?} in card {s:?}"))? as u8;
    Ok(make_card(rank, suit))
}

pub fn card_to_string(c: Card) -> String {
    debug_assert!((c as usize) < NUM_CARDS);
    let mut s = String::with_capacity(2);
    s.push(RANK_CHARS[rank(c) as usize]);
    s.push(SUIT_CHARS[suit(c) as usize]);
    s
}

/// Parses "As Kd", "AsKd", or "As,Kd". Rejects duplicates.
pub fn parse_cards(s: &str) -> Result<Vec<Card>, String> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',')
        .collect();
    if cleaned.len() % 2 != 0 {
        return Err(format!("bad card string {s:?}: odd character count"));
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes: Vec<char> = cleaned.chars().collect();
    let mut seen = 0u64;
    for pair in bytes.chunks(2) {
        let card = parse_card(&pair.iter().collect::<String>())?;
        if seen & card_mask(card) != 0 {
            return Err(format!("duplicate card {} in {s:?}", card_to_string(card)));
        }
        seen |= card_mask(card);
        out.push(card);
    }
    Ok(out)
}

pub fn cards_to_string(cards: &[Card]) -> String {
    cards
        .iter()
        .map(|&c| card_to_string(c))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_all_52() {
        for c in 0..NUM_CARDS as u8 {
            assert_eq!(parse_card(&card_to_string(c)).unwrap(), c);
        }
    }

    #[test]
    fn parse_known_cards() {
        assert_eq!(parse_card("2c").unwrap(), 0);
        assert_eq!(parse_card("As").unwrap(), 51);
        assert_eq!(rank(parse_card("Th").unwrap()), 8);
        assert_eq!(suit(parse_card("Th").unwrap()), 2);
    }

    #[test]
    fn parse_multi_formats() {
        for s in ["As Kd Qh", "AsKdQh", "As,Kd,Qh"] {
            let cards = parse_cards(s).unwrap();
            assert_eq!(cards_to_string(&cards), "As Kd Qh");
        }
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_card("Xx").is_err());
        assert!(parse_card("A").is_err());
        assert!(parse_cards("AsAs").is_err());
        assert!(parse_cards("AsK").is_err());
    }

    #[test]
    fn masks_are_disjoint() {
        let m = mask_of(&parse_cards("AsKdQh").unwrap());
        assert_eq!(m.count_ones(), 3);
    }
}
