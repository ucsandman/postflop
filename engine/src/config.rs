//! Solve configuration: everything one heads-up postflop solve needs, read from TOML.
//!
//! Range *strings* are stored verbatim here; turning them into combos is the
//! `range` module's job. Board *strings* are likewise stored verbatim, with
//! [`SolveConfig::board_cards`] as the one parsing helper the tree builder needs.

use serde::{Deserialize, Serialize};

use crate::cards::{self, Card};

/// A postflop street.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Street {
    Flop,
    Turn,
    River,
}

impl Street {
    /// The street after this one, or `None` on the river.
    pub fn next(self) -> Option<Street> {
        match self {
            Street::Flop => Some(Street::Turn),
            Street::Turn => Some(Street::River),
            Street::River => None,
        }
    }

    /// Number of board cards face up once this street is dealt.
    pub fn board_len(self) -> usize {
        match self {
            Street::Flop => 3,
            Street::Turn => 4,
            Street::River => 5,
        }
    }

    /// The street implied by a board of `len` cards.
    pub fn from_board_len(len: usize) -> Result<Street, String> {
        match len {
            3 => Ok(Street::Flop),
            4 => Ok(Street::Turn),
            5 => Ok(Street::River),
            n => Err(format!("board must be 3, 4 or 5 cards, got {n}")),
        }
    }
}

/// Which sizing table applies to an aggressive action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SizingKind {
    /// First aggressive action of the street when not facing a bet, and not a donk.
    Bet,
    /// Aggressive action facing a bet or a raise.
    Raise,
    /// OOP leading into the player who was the last aggressor on the *previous*
    /// street. Never chosen on the solve's starting street: that street has no
    /// previous street in this tree, so [`Bet`](SizingKind::Bet) is what OOP's
    /// opening lead there uses instead. [`SolveConfig::validate`] rejects a config
    /// that sets a starting-street donk table with an empty starting-street bet
    /// table, since that would leave OOP with no way to lead at all.
    Donk,
}

/// One bet-sizing table: percents of the pot, plus an optional explicit all-in.
///
/// An empty table means the action is simply not offered — a config that omits
/// every table produces a legal check-down-only tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sizings {
    /// Percents of pot, e.g. `[33.0, 75.0]`. See [`SolveConfig`] for how a percent
    /// becomes a chip amount in bet vs. raise spots.
    pub percents: Vec<f64>,
    /// Offer an all-in in addition to `percents`.
    pub allin: bool,
}

impl Sizings {
    /// Table from a percent list and an all-in flag.
    pub fn new(percents: &[f64], allin: bool) -> Sizings {
        Sizings {
            percents: percents.to_vec(),
            allin,
        }
    }

    /// True when this table offers no action at all.
    pub fn is_empty(&self) -> bool {
        self.percents.is_empty() && !self.allin
    }
}

/// Sizings for one street and one player, split by betting context.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StreetSizings {
    /// Betting when not facing a bet (and not donking).
    pub bet: Sizings,
    /// Raising when facing a bet or raise.
    pub raise: Sizings,
    /// OOP leading into the previous street's aggressor. Never consulted for IP,
    /// and never reachable on the solve's starting street — see [`SizingKind::Donk`].
    pub donk: Sizings,
}

impl StreetSizings {
    /// The table for one betting context.
    pub fn kind(&self, kind: SizingKind) -> &Sizings {
        match kind {
            SizingKind::Bet => &self.bet,
            SizingKind::Raise => &self.raise,
            SizingKind::Donk => &self.donk,
        }
    }
}

/// Per-street sizings for one player.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PlayerSizings {
    pub flop: StreetSizings,
    pub turn: StreetSizings,
    pub river: StreetSizings,
}

impl PlayerSizings {
    /// The tables for one street.
    pub fn street(&self, street: Street) -> &StreetSizings {
        match street {
            Street::Flop => &self.flop,
            Street::Turn => &self.turn,
            Street::River => &self.river,
        }
    }
}

/// Sizings for both players.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BetSizings {
    pub oop: PlayerSizings,
    pub ip: PlayerSizings,
}

impl BetSizings {
    /// The tables for one player: `0` = OOP, anything else = IP.
    pub fn player(&self, player: u8) -> &PlayerSizings {
        if player == 0 {
            &self.oop
        } else {
            &self.ip
        }
    }

    /// Every table with a dotted path, for error messages.
    fn tables(&self) -> Vec<(String, &Sizings)> {
        let mut out = Vec::with_capacity(18);
        for (pname, p) in [("oop", &self.oop), ("ip", &self.ip)] {
            for (sname, s) in [
                ("flop", &p.flop),
                ("turn", &p.turn),
                ("river", &p.river),
            ] {
                for (kname, k) in [("bet", &s.bet), ("raise", &s.raise), ("donk", &s.donk)] {
                    out.push((format!("sizings.{pname}.{sname}.{kname}"), k));
                }
            }
        }
        out
    }
}

/// Rake taken from the pot at fold and showdown terminals.
///
/// `cap` is an absolute chip ceiling on the rake; `cap = 0` means uncapped.
/// The default is no rake at all (`percent = 0`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Rake {
    /// Percent of the matched pot, e.g. `5.0`.
    pub percent: f64,
    /// Maximum rake in chips; `0` means no cap.
    pub cap: f64,
}

impl Rake {
    /// Rake owed on a matched pot. Callers must pass the *matched* pot — rake is
    /// never taken from an uncalled bet, and the tree already excludes uncalled
    /// bets from terminal pots.
    pub fn amount(&self, pot: f64) -> f64 {
        let raked = pot * self.percent / 100.0;
        if self.cap > 0.0 {
            raked.min(self.cap)
        } else {
            raked
        }
    }
}

/// How far a locked combo's action probabilities may miss 1 before the lock is
/// rejected. Loose enough for three-decimal frequencies typed by hand, tight enough
/// that a genuinely unnormalized row (`0.9`, `1.1`) never slips through.
pub const LOCK_TOL: f32 = 1e-3;

/// One frozen decision node: the acting player's strategy there is held fixed and the
/// rest of the tree is solved around it, so the result is an equilibrium **conditional**
/// on the locked play. See [`crate::game::Game::locked_strategy`] for what the solver
/// and the best-response walk do with it.
///
/// Exactly one of `freqs` and `strategy` must be given.
///
/// ```toml
/// # OOP never bluffs on this river: every combo bets or checks as told.
/// [[locks]]
/// line = ""                       # the root; "check,bet:5" walks a path first
/// player = 0                      # 0 = OOP, 1 = IP; cross-checked against the tree
/// strategy = [1.0, 1.0, 0.0,      # action 0 (check) for combos 0, 1, 2
///             0.0, 0.0, 1.0]      # action 1 (bet)   for combos 0, 1, 2
///
/// # IP calls a third of the time with everything, facing that bet.
/// [[locks]]
/// line = "bet:5"
/// player = 1
/// freqs = [0.667, 0.333]          # one per action, applied to every combo
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeLock {
    /// Path from the root to the node being locked; `""` is the root itself. See
    /// [`crate::tree::GameTree::resolve_line`] for the grammar.
    pub line: String,
    /// Acting player at that node: 0 = OOP, 1 = IP.
    pub player: u8,
    /// One frequency per action of the node, applied to every combo. Must sum to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freqs: Option<Vec<f64>>,
    /// Per-combo distribution, action-major (`strategy[a * combo_count + i]`, length
    /// `num_actions * combo_count`) — the same layout
    /// [`crate::cfr::Solver::average_strategy`] returns and the wasm bindings hand out,
    /// so a strategy read out of a solution can be edited and locked back in unchanged.
    /// The combo axis is the node's live combos in canonical ascending order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<Vec<f64>>,
}

impl NodeLock {
    /// Expands this lock into the action-major distribution the solver freezes into the
    /// node: `[a * combo_count + i]`, length `num_actions * combo_count`.
    ///
    /// `freqs` is broadcast across every combo; `strategy` is taken as given. Either way
    /// every combo's column must be non-negative and sum to 1 within [`LOCK_TOL`].
    ///
    /// The arity checks need the tree (a node's action count) and the board (its live
    /// combo count), so they land here rather than in [`SolveConfig::validate`], which
    /// runs before either exists.
    pub fn expand(&self, num_actions: usize, combo_count: usize) -> Result<Vec<f32>, String> {
        let out: Vec<f32> = match (&self.freqs, &self.strategy) {
            (Some(f), None) => {
                if f.len() != num_actions {
                    return Err(format!(
                        "freqs has {} entries but the node offers {num_actions} actions",
                        f.len()
                    ));
                }
                let mut v = vec![0.0f32; num_actions * combo_count];
                for (a, &p) in f.iter().enumerate() {
                    v[a * combo_count..(a + 1) * combo_count].fill(p as f32);
                }
                v
            }
            (None, Some(s)) => {
                let want = num_actions * combo_count;
                if s.len() != want {
                    return Err(format!(
                        "strategy has {} entries but the node needs {num_actions} actions * \
                         {combo_count} combos = {want}",
                        s.len()
                    ));
                }
                s.iter().map(|&x| x as f32).collect()
            }
            _ => return Err("set exactly one of `freqs` and `strategy`".to_string()),
        };

        for i in 0..combo_count {
            let mut sum = 0.0f32;
            for a in 0..num_actions {
                let v = out[a * combo_count + i];
                if !v.is_finite() || v < 0.0 {
                    return Err(format!(
                        "combo {i} action {a} has probability {v}; must be finite and \
                         non-negative"
                    ));
                }
                sum += v;
            }
            if (sum - 1.0).abs() > LOCK_TOL {
                return Err(format!(
                    "combo {i}'s action probabilities sum to {sum}, not 1 (tolerance \
                     {LOCK_TOL})"
                ));
            }
        }
        // Renormalize any combo column that is off 1 by more than float noise: a
        // hand-written lock summing to 1.0009 passes the tolerance above but would
        // scale every chip figure reported for the solve by up to that factor. The
        // 1e-6 floor keeps a round-tripped average strategy (off by accumulated f32
        // ulps only) frozen bit-for-bit, which locking tests pin deliberately.
        let mut out = out;
        for i in 0..combo_count {
            let sum: f32 = (0..num_actions).map(|a| out[a * combo_count + i]).sum();
            if sum > 0.0 && (sum - 1.0).abs() > 1e-6 {
                for a in 0..num_actions {
                    out[a * combo_count + i] /= sum;
                }
            }
        }
        Ok(out)
    }

    /// Everything checkable without a tree: which field is set, the player id, and that
    /// the numbers are probabilities. Arity and per-combo normalization wait for
    /// [`NodeLock::expand`].
    fn validate_shape(&self) -> Result<(), String> {
        if self.player > 1 {
            return Err(format!("player must be 0 (OOP) or 1 (IP), got {}", self.player));
        }
        let values = match (&self.freqs, &self.strategy) {
            (Some(f), None) => f,
            (None, Some(s)) => s,
            (Some(_), Some(_)) => {
                return Err("set `freqs` or `strategy`, not both".to_string());
            }
            (None, None) => return Err("set one of `freqs` or `strategy`".to_string()),
        };
        if values.is_empty() {
            return Err("the locked distribution is empty".to_string());
        }
        for &v in values {
            if !v.is_finite() || !(0.0..=1.0).contains(&v) {
                return Err(format!("probability {v} is outside [0, 1]"));
            }
        }
        if let Some(f) = &self.freqs {
            let sum: f64 = f.iter().sum();
            if (sum - 1.0).abs() > LOCK_TOL as f64 {
                return Err(format!(
                    "freqs sum to {sum}, not 1 (tolerance {LOCK_TOL})"
                ));
            }
        }
        Ok(())
    }
}

const fn default_allin_threshold() -> f64 {
    67.0
}
const fn default_raise_cap() -> u32 {
    3
}
const fn default_target_exploitability() -> f64 {
    0.5
}
const fn default_max_iterations() -> u64 {
    1000
}
const fn default_alpha() -> f64 {
    1.5
}
const fn default_beta() -> f64 {
    0.0
}
const fn default_gamma() -> f64 {
    2.0
}

/// Configuration for one solve.
///
/// # Percent-of-pot sizings
///
/// * **Bet** (no bet outstanding): the player puts in `pot * percent / 100`, where
///   `pot` is the total pot at that node.
/// * **Raise** (facing a bet): the raise *adds* `percent / 100` of the pot-as-it-would-be
///   after calling, on top of the call. So `raise_to = opponent_bet + (pot + to_call) * percent / 100`.
///
/// Both are then floored at the legal minimum (min-bet / min-raise), capped at the
/// player's remaining stack, and rounded to the nearest 0.01 chip.
///
/// # All-in threshold
///
/// `allin_threshold` is a percent. If the *additional* chips a sizing would put in
/// are `>= allin_threshold / 100 * remaining_stack`, that sizing is replaced by the
/// all-in. With the default `67`, a bet worth 67% or more of the shove becomes the
/// shove. Duplicate resulting amounts are collapsed to one action.
///
/// # Raise cap
///
/// `raise_cap` counts *raises* per street; the opening bet of a street is not a
/// raise. All-in is **not** exempt: once the cap is reached the player facing the
/// last raise may only fold or call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolveConfig {
    /// Board as a card string, 3 (flop), 4 (turn) or 5 (river) cards, e.g. `"As Kd 7h"`.
    pub board: String,
    /// Out-of-position range string. Parsed by the `range` module, not here.
    pub oop_range: String,
    /// In-position range string. Parsed by the `range` module, not here.
    pub ip_range: String,
    /// Chips behind, per player, at the root node.
    pub effective_stack: f64,
    /// Chips already in the middle at the root node.
    pub starting_pot: f64,

    /// Percent threshold at which a sizing collapses into the all-in. See the type docs.
    #[serde(default = "default_allin_threshold")]
    pub allin_threshold: f64,
    /// Maximum raises per street, excluding the opening bet. See the type docs.
    #[serde(default = "default_raise_cap")]
    pub raise_cap: u32,
    /// Stop when exploitability falls below this percent of the starting pot.
    #[serde(default = "default_target_exploitability")]
    pub target_exploitability: f64,
    /// Hard iteration ceiling.
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u64,
    /// Discounted CFR positive-regret exponent.
    #[serde(default = "default_alpha")]
    pub alpha: f64,
    /// Discounted CFR negative-regret exponent.
    #[serde(default = "default_beta")]
    pub beta: f64,
    /// Discounted CFR strategy-averaging exponent.
    #[serde(default = "default_gamma")]
    pub gamma: f64,
    /// APPROXIMATE speed mode: sample turn cards instead of enumerating them.
    /// Results are no longer an exact equilibrium of the full tree.
    #[serde(default)]
    pub turn_chance_sampling: bool,
    /// CFR+/DCFR+ style positive-regret floor: clamp cumulative regret at zero right
    /// after each update, so a negative regret never has to be climbed back out of.
    /// Wired straight through to `DcfrParams::floor_regrets_at_zero`. Off by default,
    /// matching plain Discounted CFR.
    #[serde(default)]
    pub regret_floor: bool,

    /// Rake applied at terminals. Default: none.
    #[serde(default)]
    pub rake: Rake,
    /// Bet sizing tables. Any omitted table means that action is not offered.
    #[serde(default)]
    pub sizings: BetSizings,
    /// Decision nodes whose strategy is frozen, solved around rather than solved for.
    /// Default: none, and a solve with none is exactly the solve it always was.
    /// See [`NodeLock`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locks: Vec<NodeLock>,
}

impl Default for SolveConfig {
    fn default() -> SolveConfig {
        SolveConfig {
            board: String::new(),
            oop_range: String::new(),
            ip_range: String::new(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            allin_threshold: default_allin_threshold(),
            raise_cap: default_raise_cap(),
            target_exploitability: default_target_exploitability(),
            max_iterations: default_max_iterations(),
            alpha: default_alpha(),
            beta: default_beta(),
            gamma: default_gamma(),
            turn_chance_sampling: false,
            regret_floor: false,
            rake: Rake::default(),
            sizings: BetSizings::default(),
            locks: Vec::new(),
        }
    }
}

impl SolveConfig {
    /// Parses a TOML document and validates it.
    ///
    /// Unknown keys are rejected so a typo'd sizing table cannot silently disable
    /// an action.
    pub fn from_toml_str(s: &str) -> Result<SolveConfig, String> {
        let cfg: SolveConfig =
            toml::from_str(s).map_err(|e| format!("invalid TOML config: {e}"))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Parses [`SolveConfig::board`] into 3, 4 or 5 distinct cards.
    pub fn board_cards(&self) -> Result<Vec<Card>, String> {
        let board = cards::parse_cards(&self.board)?;
        Street::from_board_len(board.len())?;
        Ok(board)
    }

    /// The street the solve starts on, from the board length.
    pub fn starting_street(&self) -> Result<Street, String> {
        Street::from_board_len(self.board_cards()?.len())
    }

    /// The sizing table for a player / street / betting context.
    pub fn sizings_for(&self, player: u8, street: Street, kind: SizingKind) -> &Sizings {
        self.sizings.player(player).street(street).kind(kind)
    }

    /// Checks every field for a value the solver can actually run on.
    pub fn validate(&self) -> Result<(), String> {
        self.board_cards()?;
        if self.oop_range.trim().is_empty() {
            return Err("oop_range is empty".to_string());
        }
        if self.ip_range.trim().is_empty() {
            return Err("ip_range is empty".to_string());
        }
        positive("effective_stack", self.effective_stack)?;
        positive("starting_pot", self.starting_pot)?;

        if !(self.allin_threshold.is_finite()
            && self.allin_threshold > 0.0
            && self.allin_threshold <= 100.0)
        {
            return Err(format!(
                "allin_threshold must be in (0, 100], got {}",
                self.allin_threshold
            ));
        }

        for (path, table) in self.sizings.tables() {
            for &pct in &table.percents {
                if !pct.is_finite() || pct <= 0.0 {
                    return Err(format!(
                        "{path}.percents contains {pct}; percents must be positive and finite"
                    ));
                }
            }
        }

        // Donk sizings only ever fire when OOP leads into the player who was the
        // aggressor on the *previous* street (see `StreetSizings::donk`). The
        // starting street has no previous street in this tree, so a donk table
        // there can never be reached. If `bet` is also empty for that street, OOP
        // has no way to lead at all — the tree builds silently with OOP unable to
        // bet first, which is the bug this guards against. (If `bet` is non-empty,
        // OOP can still lead through it; the donk entry is merely inert.)
        let starting_street = self.starting_street()?;
        let start_oop = self.sizings.oop.street(starting_street);
        if !start_oop.donk.is_empty() && start_oop.bet.is_empty() {
            let street_name = match starting_street {
                Street::Flop => "flop",
                Street::Turn => "turn",
                Street::River => "river",
            };
            return Err(format!(
                "sizings.oop.{street_name}.donk is set but sizings.oop.{street_name}.bet is \
                 empty: donk sizings never apply on the starting street (there is no prior \
                 street's aggressor yet), so OOP would have no lead sizings at all — put OOP's \
                 starting-street lead sizings in `bet`, not `donk`"
            ));
        }

        if !(self.rake.percent.is_finite() && (0.0..=100.0).contains(&self.rake.percent)) {
            return Err(format!(
                "rake.percent must be in [0, 100], got {}",
                self.rake.percent
            ));
        }
        if !self.rake.cap.is_finite() || self.rake.cap < 0.0 {
            return Err(format!(
                "rake.cap must be a non-negative finite number, got {}",
                self.rake.cap
            ));
        }

        if !self.target_exploitability.is_finite() || self.target_exploitability < 0.0 {
            return Err(format!(
                "target_exploitability must be a non-negative finite percent, got {}",
                self.target_exploitability
            ));
        }
        if self.max_iterations == 0 {
            return Err("max_iterations must be at least 1".to_string());
        }
        for (name, v) in [
            ("alpha", self.alpha),
            ("beta", self.beta),
            ("gamma", self.gamma),
        ] {
            if !v.is_finite() {
                return Err(format!("{name} must be finite, got {v}"));
            }
        }

        // Locks are checked as far as they can be without a tree; the line, the arity
        // and the per-combo sums need one, and are checked when the game is built.
        for (i, lock) in self.locks.iter().enumerate() {
            lock.validate_shape()
                .map_err(|e| format!("locks[{i}] (line {:?}): {e}", lock.line))?;
        }
        Ok(())
    }
}

fn positive(name: &str, v: f64) -> Result<(), String> {
    if v.is_finite() && v > 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must be a positive finite number, got {v}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
board = "As Kd 7h"
oop_range = "22+,A2s+"
ip_range = "random"
effective_stack = 200.0
starting_pot = 12.5
allin_threshold = 80.0
raise_cap = 2
target_exploitability = 0.25
max_iterations = 5000
alpha = 1.0
beta = 0.5
gamma = 3.0
turn_chance_sampling = true

[rake]
percent = 5.0
cap = 3.0

[sizings.oop.flop]
bet = { percents = [33.0, 75.0], allin = true }
raise = { percents = [60.0] }

[sizings.ip.flop]
bet = { percents = [50.0] }

[sizings.oop.turn]
donk = { percents = [25.0] }

[sizings.ip.river]
bet = { percents = [125.0], allin = true }
"#;

    const MINIMAL: &str = r#"
board = "AsKd7h2c9s"
oop_range = "random"
ip_range = "random"
effective_stack = 100.0
starting_pot = 10.0
"#;

    #[test]
    fn full_toml_roundtrips() {
        let cfg = SolveConfig::from_toml_str(FULL).expect("parse");
        assert_eq!(cfg.board, "As Kd 7h");
        assert_eq!(cfg.oop_range, "22+,A2s+");
        assert_eq!(cfg.effective_stack, 200.0);
        assert_eq!(cfg.starting_pot, 12.5);
        assert_eq!(cfg.allin_threshold, 80.0);
        assert_eq!(cfg.raise_cap, 2);
        assert_eq!(cfg.target_exploitability, 0.25);
        assert_eq!(cfg.max_iterations, 5000);
        assert_eq!((cfg.alpha, cfg.beta, cfg.gamma), (1.0, 0.5, 3.0));
        assert!(cfg.turn_chance_sampling);
        assert_eq!(cfg.rake, Rake { percent: 5.0, cap: 3.0 });
        assert_eq!(cfg.sizings.oop.flop.bet, Sizings::new(&[33.0, 75.0], true));
        assert_eq!(cfg.sizings.oop.flop.raise, Sizings::new(&[60.0], false));
        assert_eq!(cfg.sizings.oop.flop.donk, Sizings::default());
        assert_eq!(cfg.sizings.oop.turn.donk, Sizings::new(&[25.0], false));
        assert_eq!(cfg.sizings.ip.river.bet, Sizings::new(&[125.0], true));
        assert_eq!(cfg.starting_street().unwrap(), Street::Flop);

        // Serialize back out and re-read: same config.
        let out = toml::to_string(&cfg).expect("serialize");
        let again = SolveConfig::from_toml_str(&out).expect("reparse");
        assert_eq!(cfg, again);
    }

    #[test]
    fn minimal_toml_uses_defaults() {
        let cfg = SolveConfig::from_toml_str(MINIMAL).expect("parse");
        assert_eq!(cfg.allin_threshold, 67.0);
        assert_eq!(cfg.raise_cap, 3);
        assert_eq!((cfg.alpha, cfg.beta, cfg.gamma), (1.5, 0.0, 2.0));
        assert_eq!(cfg.max_iterations, 1000);
        assert!(!cfg.turn_chance_sampling);
        assert_eq!(cfg.rake, Rake::default());
        assert!(cfg.sizings.oop.flop.bet.is_empty());
        assert!(cfg.sizings.ip.river.raise.is_empty());
        assert_eq!(cfg.starting_street().unwrap(), Street::River);

        let out = toml::to_string(&cfg).expect("serialize");
        assert_eq!(SolveConfig::from_toml_str(&out).expect("reparse"), cfg);
    }

    #[test]
    fn unknown_key_is_rejected() {
        let bad = format!("{MINIMAL}\nbet_sizes = [50.0]\n");
        let err = SolveConfig::from_toml_str(&bad).unwrap_err();
        assert!(err.contains("bet_sizes"), "{err}");
    }

    #[test]
    fn validate_rejects_bad_values() {
        let ok = SolveConfig::from_toml_str(MINIMAL).expect("baseline parses");
        let cases: [(SolveConfig, &str); 8] = [
            (SolveConfig { board: "As Kd".into(), ..ok.clone() }, "3, 4 or 5"),
            (SolveConfig { oop_range: " ".into(), ..ok.clone() }, "oop_range"),
            (SolveConfig { ip_range: String::new(), ..ok.clone() }, "ip_range"),
            (SolveConfig { effective_stack: 0.0, ..ok.clone() }, "effective_stack"),
            (SolveConfig { starting_pot: -1.0, ..ok.clone() }, "starting_pot"),
            (SolveConfig { allin_threshold: 0.0, ..ok.clone() }, "allin_threshold"),
            (SolveConfig { max_iterations: 0, ..ok.clone() }, "max_iterations"),
            (
                SolveConfig { rake: Rake { percent: 120.0, cap: 0.0 }, ..ok.clone() },
                "rake.percent",
            ),
        ];
        for (cfg, needle) in cases {
            let err = cfg.validate().expect_err(&format!("expected failure, needle {needle}"));
            assert!(err.contains(needle), "wanted {needle}, got {err}");
        }
    }

    #[test]
    fn validate_rejects_non_positive_sizing_percent() {
        let mut cfg = SolveConfig::from_toml_str(MINIMAL).expect("parse");
        cfg.sizings.ip.turn.raise = Sizings::new(&[50.0, -10.0], false);
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("sizings.ip.turn.raise"), "{err}");
    }

    #[test]
    fn validate_rejects_duplicate_board_cards() {
        let cfg = SolveConfig {
            board: "As As 7h".to_string(),
            oop_range: "random".to_string(),
            ip_range: "random".to_string(),
            ..SolveConfig::default()
        };
        assert!(cfg.validate().unwrap_err().contains("duplicate"));
    }

    #[test]
    fn rake_caps_and_defaults_to_zero() {
        assert_eq!(Rake::default().amount(100.0), 0.0);
        assert_eq!(Rake { percent: 5.0, cap: 3.0 }.amount(100.0), 3.0);
        assert_eq!(Rake { percent: 5.0, cap: 3.0 }.amount(20.0), 1.0);
        assert_eq!(Rake { percent: 5.0, cap: 0.0 }.amount(100.0), 5.0);
    }

    #[test]
    fn validate_rejects_donk_on_the_starting_street_with_empty_bet() {
        // MINIMAL's board is 5 cards, so the starting street is the river: there is
        // no prior street, so a river donk table can never fire.
        let mut cfg = SolveConfig::from_toml_str(MINIMAL).expect("baseline parses");
        cfg.sizings.oop.river.donk = Sizings::new(&[50.0], false);
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("donk"), "{err}");
        assert!(err.contains("starting street"), "{err}");
    }

    #[test]
    fn donk_on_the_starting_street_is_fine_once_bet_is_also_set() {
        // OOP can still lead via `bet`; the redundant `donk` entry is dead weight,
        // not a silent inability to lead, so this is not an error.
        let mut cfg = SolveConfig::from_toml_str(MINIMAL).expect("baseline parses");
        cfg.sizings.oop.river.bet = Sizings::new(&[50.0], false);
        cfg.sizings.oop.river.donk = Sizings::new(&[25.0], false);
        cfg.validate().expect("bet present makes the donk table harmless");
    }

    #[test]
    fn regret_floor_defaults_false_and_round_trips() {
        let cfg = SolveConfig::from_toml_str(MINIMAL).expect("parse");
        assert!(!cfg.regret_floor);

        let with_floor = format!("{MINIMAL}\nregret_floor = true\n");
        let cfg2 = SolveConfig::from_toml_str(&with_floor).expect("parse with regret_floor");
        assert!(cfg2.regret_floor);

        let out = toml::to_string(&cfg2).expect("serialize");
        assert!(SolveConfig::from_toml_str(&out).expect("reparse").regret_floor);
    }

    #[test]
    fn locks_round_trip_through_toml() {
        let text = format!(
            "{MINIMAL}\n\
             [[locks]]\n\
             line = \"\"\n\
             player = 0\n\
             strategy = [1.0, 0.25, 0.0, 0.75]\n\
             \n\
             [[locks]]\n\
             line = \"check,bet:5\"\n\
             player = 1\n\
             freqs = [0.667, 0.333]\n"
        );
        let cfg = SolveConfig::from_toml_str(&text).expect("parse");
        assert_eq!(cfg.locks.len(), 2);
        assert_eq!(cfg.locks[0].line, "");
        assert_eq!(cfg.locks[0].player, 0);
        assert_eq!(cfg.locks[0].strategy, Some(vec![1.0, 0.25, 0.0, 0.75]));
        assert_eq!(cfg.locks[0].freqs, None);
        assert_eq!(cfg.locks[1].line, "check,bet:5");
        assert_eq!(cfg.locks[1].freqs, Some(vec![0.667, 0.333]));

        // The whole config, locks included, survives a serialize/parse round trip — the
        // path a saved solution's embedded config takes.
        let out = toml::to_string(&cfg).expect("serialize");
        assert_eq!(SolveConfig::from_toml_str(&out).expect("reparse"), cfg);

        // Two actions, two combos: broadcast and per-combo expand to the same layout.
        assert_eq!(
            cfg.locks[0].expand(2, 2).expect("expand"),
            vec![1.0, 0.25, 0.0, 0.75]
        );
        assert_eq!(cfg.locks[1].expand(2, 3).expect("expand"), vec![
            0.667, 0.667, 0.667, 0.333, 0.333, 0.333
        ]);
        // Default: no locks at all, and the key is omitted rather than written empty.
        let plain = SolveConfig::from_toml_str(MINIMAL).expect("parse");
        assert!(plain.locks.is_empty());
        assert!(!toml::to_string(&plain).expect("serialize").contains("locks"));
    }

    #[test]
    fn validate_rejects_a_malformed_lock() {
        let ok = SolveConfig::from_toml_str(MINIMAL).expect("baseline parses");
        let with = |lock: NodeLock| SolveConfig { locks: vec![lock], ..ok.clone() };
        let base = NodeLock {
            line: String::new(),
            player: 0,
            freqs: Some(vec![0.5, 0.5]),
            strategy: None,
        };
        let cases: [(NodeLock, &str); 6] = [
            (NodeLock { player: 2, ..base.clone() }, "player must be 0"),
            (
                NodeLock { strategy: Some(vec![1.0, 0.0]), ..base.clone() },
                "not both",
            ),
            (NodeLock { freqs: None, ..base.clone() }, "set one of"),
            (NodeLock { freqs: Some(vec![]), ..base.clone() }, "is empty"),
            (NodeLock { freqs: Some(vec![1.5, -0.5]), ..base.clone() }, "outside [0, 1]"),
            (NodeLock { freqs: Some(vec![0.5, 0.4]), ..base.clone() }, "sum to 0.9"),
        ];
        for (lock, needle) in cases {
            let err = with(lock).validate().expect_err(needle);
            assert!(err.contains(needle), "wanted {needle:?}, got {err}");
            assert!(err.starts_with("locks[0]"), "error should name the entry: {err}");
        }

        // Arity and per-combo sums need the node, so they land in `expand`.
        assert!(base.expand(3, 1).unwrap_err().contains("offers 3 actions"));
        let per_combo = NodeLock { freqs: None, strategy: Some(vec![0.5, 0.0, 0.0]), ..base };
        assert!(per_combo.expand(2, 2).unwrap_err().contains("= 4"));
        let err = per_combo.expand(3, 1).unwrap_err();
        assert!(err.contains("sum to 0.5, not 1"), "unnormalized row must be rejected: {err}");
    }

    #[test]
    fn street_helpers() {
        assert_eq!(Street::Flop.next(), Some(Street::Turn));
        assert_eq!(Street::River.next(), None);
        assert_eq!(Street::Turn.board_len(), 4);
        assert_eq!(Street::from_board_len(5).unwrap(), Street::River);
        assert!(Street::from_board_len(2).is_err());
    }
}
