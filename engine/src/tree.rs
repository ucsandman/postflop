//! The public game tree: an arena of [`Node`]s built once from a [`SolveConfig`]
//! and a parsed board.
//!
//! The tree is pure *public* state — pot, stacks, street, whose turn it is, and the
//! legal actions. It knows nothing about ranges, combos or hole cards. Chance nodes
//! mark a card dead only when it is already on the board at that node; hole-card
//! blocking is the CFR layer's job.
//!
//! # Invariants held at every node
//!
//! * `pot + stacks[0] + stacks[1] == starting_pot + 2 * effective_stack`
//! * `stacks[p] >= 0`
//! * `pot` is the *live* pot: at a fold terminal the uncalled bet has already been
//!   returned to the bettor's stack, so rake may be applied to the terminal pot
//!   directly.
//!
//! # Chip amounts and rounding
//!
//! Amounts are chips as `f64`, derived from the percent-of-pot tables in
//! [`SolveConfig`] and rounded to the nearest 0.01 chip, then floored at the legal
//! minimum (min-bet 0.01, min-raise = previous raise increment) and capped at the
//! acting player's remaining stack. See [`SolveConfig`] for the exact percent
//! formulas, the all-in threshold, and the raise cap.

use crate::cards::{self, Card, NUM_CARDS};
use crate::config::{NodeLock, SizingKind, SolveConfig};

pub use crate::config::Street;

/// Sentinel in [`NodeKind::Chance::child_for_card`] for a card that cannot be dealt.
pub const NO_CHILD: u32 = u32::MAX;

/// Chip granularity. Amounts are rounded to this grid, and it doubles as the min bet.
const MIN_CHIP: f64 = 0.01;

/// Slack for chip comparisons, an order of magnitude tighter than [`MIN_CHIP`] is coarse.
const EPS: f64 = 1e-6;

/// What a player did.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ActionLabel {
    Fold,
    Check,
    Call,
    /// Opening bet of a street. The payload is the chips this player has in for the
    /// street after betting (which equals the chips added, since it is the first bet).
    Bet(f64),
    /// Raise. The payload is the *total* this player has in for the street afterwards.
    Raise(f64),
    /// All remaining chips. The resulting amounts are visible on the child node.
    AllIn,
}

impl ActionLabel {
    /// This action as a line token — the form [`GameTree::resolve_line`] parses.
    ///
    /// `bet` and `raise` carry the street total the player has in afterwards, which is
    /// the number the label itself carries. Amounts sit on the 0.01 chip grid, so the
    /// shortest round-tripping decimal is exact.
    pub fn token(self) -> String {
        match self {
            ActionLabel::Fold => "fold".to_string(),
            ActionLabel::Check => "check".to_string(),
            ActionLabel::Call => "call".to_string(),
            ActionLabel::AllIn => "allin".to_string(),
            ActionLabel::Bet(x) => format!("bet:{x}"),
            ActionLabel::Raise(x) => format!("raise:{x}"),
        }
    }
}

/// One parsed step of a line: an action, with the amount left open when the token
/// omitted it.
enum Want {
    Fold,
    Check,
    Call,
    AllIn,
    Bet(Option<f64>),
    Raise(Option<f64>),
}

impl Want {
    fn parse(tok: &str) -> Result<Want, String> {
        let (head, amount) = match tok.split_once(':') {
            Some((h, a)) => {
                let v: f64 = a.trim().parse().map_err(|_| {
                    format!("bad amount {:?} in step {tok:?}", a.trim())
                })?;
                (h.trim(), Some(v))
            }
            None => (tok, None),
        };
        match head.to_ascii_lowercase().as_str() {
            "bet" => Ok(Want::Bet(amount)),
            "raise" => Ok(Want::Raise(amount)),
            other if amount.is_some() => {
                Err(format!("{other:?} takes no amount, got {tok:?}"))
            }
            "fold" => Ok(Want::Fold),
            "check" => Ok(Want::Check),
            "call" => Ok(Want::Call),
            "allin" | "all-in" => Ok(Want::AllIn),
            other => Err(format!(
                "unknown action {other:?}; expected fold, check, call, allin, \
                 bet[:<to>] or raise[:<to>]"
            )),
        }
    }

    fn matches(&self, label: ActionLabel) -> bool {
        match (self, label) {
            (Want::Fold, ActionLabel::Fold)
            | (Want::Check, ActionLabel::Check)
            | (Want::Call, ActionLabel::Call)
            | (Want::AllIn, ActionLabel::AllIn) => true,
            (Want::Bet(want), ActionLabel::Bet(x)) | (Want::Raise(want), ActionLabel::Raise(x)) => {
                want.is_none_or(|v| (v - x).abs() < EPS)
            }
            _ => false,
        }
    }
}

/// One edge out of a decision node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Action {
    pub label: ActionLabel,
    /// Index of the resulting node in the arena.
    pub child: u32,
}

/// A terminal payoff node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Terminal {
    /// `folder` gave up. `pot` is the matched pot — the uncalled bet is already back
    /// in the bettor's stack — so the non-folder wins `pot` less any rake.
    Fold { folder: u8, pot: f64 },
    /// Both players are in for `pot`, which is awarded by hand strength less any rake.
    Showdown { pot: f64 },
}

/// The three node kinds.
#[derive(Debug, Clone)]
pub enum NodeKind {
    /// A player to act. `player` is 0 for OOP, 1 for IP.
    Decision { player: u8, actions: Vec<Action> },
    /// A card is dealt, starting `street`. `child_for_card[c]` is [`NO_CHILD`] when
    /// card `c` is already on the board at this node.
    Chance {
        street: Street,
        child_for_card: Box<[u32; NUM_CARDS]>,
    },
    Terminal(Terminal),
}

/// One node of the arena.
#[derive(Debug, Clone)]
pub struct Node {
    pub kind: NodeKind,
    /// Live chips in the middle, including an outstanding bet at a decision node.
    pub pot: f64,
    /// Chips still behind: `[OOP, IP]`.
    pub stacks: [f64; 2],
    /// The street in progress. For a chance node, the street being dealt.
    pub street: Street,
}

impl Node {
    /// The smaller of the two remaining stacks — what is still playable.
    pub fn effective_stack(&self) -> f64 {
        self.stacks[0].min(self.stacks[1])
    }

    /// True for fold and showdown nodes.
    pub fn is_terminal(&self) -> bool {
        matches!(self.kind, NodeKind::Terminal(_))
    }
}

/// Node totals by kind, for tests and diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NodeCounts {
    pub decision: usize,
    pub chance: usize,
    pub fold: usize,
    pub showdown: usize,
    pub total: usize,
}

/// The built tree. Root is index 0.
#[derive(Debug, Clone)]
pub struct GameTree {
    nodes: Vec<Node>,
    board: Vec<Card>,
    starting_street: Street,
}

impl GameTree {
    /// Builds the whole tree for `cfg` on `board`.
    ///
    /// `board` must be the 3, 4 or 5 distinct cards the solve starts from; use
    /// [`SolveConfig::board_cards`] to get them.
    pub fn build(cfg: &SolveConfig, board: &[Card]) -> Result<GameTree, String> {
        let starting_street = Street::from_board_len(board.len())?;
        let board_mask = cards::mask_of(board);
        if board_mask.count_ones() as usize != board.len() {
            return Err("board contains duplicate cards".to_string());
        }
        if board.iter().any(|&c| (c as usize) >= NUM_CARDS) {
            return Err("board contains an out-of-range card".to_string());
        }
        if !cfg.effective_stack.is_finite() || cfg.effective_stack <= 0.0 {
            return Err(format!(
                "effective_stack must be a positive finite number, got {}",
                cfg.effective_stack
            ));
        }
        if !cfg.starting_pot.is_finite() || cfg.starting_pot <= 0.0 {
            return Err(format!(
                "starting_pot must be a positive finite number, got {}",
                cfg.starting_pot
            ));
        }

        let mut builder = Builder {
            cfg,
            nodes: Vec::new(),
        };
        let root = State {
            street: starting_street,
            pot: cfg.starting_pot,
            stacks: [cfg.effective_stack; 2],
            bets: [0.0; 2],
            to_act: 0,
            acted: false,
            raises: 0,
            last_raise: 0.0,
            street_aggressor: None,
            prev_aggressor: None,
            board_mask,
        };
        builder.betting_node(root);
        Ok(GameTree {
            nodes: builder.nodes,
            board: board.to_vec(),
            starting_street,
        })
    }

    /// Index of the root node (always 0).
    pub fn root(&self) -> u32 {
        0
    }

    /// Node by index. Panics on an index this tree never produced.
    pub fn node(&self, index: u32) -> &Node {
        &self.nodes[index as usize]
    }

    /// All nodes, in creation order (parents before their children).
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    /// Number of nodes.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Always false for a built tree; present for the usual `len`/`is_empty` pair.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The board the tree was built on.
    pub fn board(&self) -> &[Card] {
        &self.board
    }

    /// The street the root node is on.
    pub fn starting_street(&self) -> Street {
        self.starting_street
    }

    /// Child indices of a node: action children for a decision node, live card
    /// children for a chance node, nothing for a terminal.
    pub fn children(&self, index: u32) -> impl Iterator<Item = u32> + '_ {
        let kind = &self.nodes[index as usize].kind;
        let actions: &[Action] = match kind {
            NodeKind::Decision { actions, .. } => actions,
            _ => &[],
        };
        let cards: &[u32] = match kind {
            NodeKind::Chance { child_for_card, .. } => &child_for_card[..],
            _ => &[],
        };
        actions
            .iter()
            .map(|a| a.child)
            .chain(cards.iter().copied().filter(|&c| c != NO_CHILD))
    }

    /// Resolves a **line** — a path from the root, written the way a human reads a hand
    /// history — to the node it reaches.
    ///
    /// Steps are separated by commas and whitespace around them is ignored. At a
    /// decision node a step is an action token: `fold`, `check`, `call`, `allin`,
    /// `bet:<to>` or `raise:<to>`, where `<to>` is the **street total** the acting player
    /// has in after the action (the number [`ActionLabel::Bet`] carries, and the
    /// `amount_to` the wasm bindings report). The amount may be dropped when the node
    /// offers exactly one bet, or exactly one raise; two candidates is an error rather
    /// than a silent pick. At a chance node a step is the dealt card, e.g. `Ah`. An
    /// empty line is the root.
    ///
    /// ```text
    /// ""                     the root
    /// "check,bet:5"          OOP checks, IP bets to 5
    /// "bet:5,call,Ah,check"  OOP leads 5, IP calls, the Ah comes, OOP checks
    /// ```
    ///
    /// [`ActionLabel::token`] writes a step in exactly this form, so a line can be built
    /// by walking a path and joining the tokens with commas.
    pub fn resolve_line(&self, line: &str) -> Result<u32, String> {
        if line.trim().is_empty() {
            return Ok(self.root());
        }
        let mut node = self.root();
        for (k, raw) in line.split(',').enumerate() {
            let tok = raw.trim();
            if tok.is_empty() {
                return Err(format!("line {line:?}: step {} is empty", k + 1));
            }
            node = self
                .step(node, tok)
                .map_err(|e| format!("line {line:?}: step {} ({tok:?}) {e}", k + 1))?;
        }
        Ok(node)
    }

    /// One step of [`GameTree::resolve_line`].
    fn step(&self, node: u32, tok: &str) -> Result<u32, String> {
        match &self.nodes[node as usize].kind {
            NodeKind::Decision { actions, .. } => {
                let want = Want::parse(tok)?;
                let mut hit = None;
                for a in actions {
                    if !want.matches(a.label) {
                        continue;
                    }
                    if hit.is_some() {
                        return Err(format!(
                            "is ambiguous at node {node}; name the amount, one of {}",
                            self.action_tokens(actions)
                        ));
                    }
                    hit = Some(a.child);
                }
                hit.ok_or_else(|| {
                    format!(
                        "is not offered at node {node}; available: {}",
                        self.action_tokens(actions)
                    )
                })
            }
            NodeKind::Chance { child_for_card, .. } => {
                let card = cards::parse_card(tok)
                    .map_err(|e| format!("must be the card dealt at chance node {node}: {e}"))?;
                match child_for_card[card as usize] {
                    NO_CHILD => Err(format!(
                        "cannot be dealt at node {node}; it is already on the board"
                    )),
                    child => Ok(child),
                }
            }
            NodeKind::Terminal(_) => Err(format!(
                "runs past the end of the hand; node {node} is a terminal"
            )),
        }
    }

    fn action_tokens(&self, actions: &[Action]) -> String {
        actions
            .iter()
            .map(|a| a.label.token())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Resolves one [`NodeLock`] against this tree: the node its `line` names, and how
    /// many actions that node offers.
    ///
    /// Rejects a line that lands anywhere but a decision node, and one whose node the
    /// *other* player acts at — a lock names its player so a config that drifts out of
    /// step with the tree fails loudly instead of freezing the wrong range.
    pub fn resolve_lock(&self, lock: &NodeLock) -> Result<(u32, usize), String> {
        let node = self.resolve_line(&lock.line)?;
        match &self.node(node).kind {
            NodeKind::Decision { player, actions } if *player == lock.player => {
                Ok((node, actions.len()))
            }
            NodeKind::Decision { player, .. } => Err(format!(
                "line {:?} reaches node {node}, where player {player} acts, not player {}",
                lock.line, lock.player
            )),
            NodeKind::Chance { .. } => Err(format!(
                "line {:?} reaches node {node}, a chance node; only decision nodes can be locked",
                lock.line
            )),
            NodeKind::Terminal(_) => Err(format!(
                "line {:?} reaches node {node}, a terminal; only decision nodes can be locked",
                lock.line
            )),
        }
    }

    /// Node totals by kind.
    pub fn counts(&self) -> NodeCounts {
        let mut c = NodeCounts {
            total: self.nodes.len(),
            ..NodeCounts::default()
        };
        for node in &self.nodes {
            match node.kind {
                NodeKind::Decision { .. } => c.decision += 1,
                NodeKind::Chance { .. } => c.chance += 1,
                NodeKind::Terminal(Terminal::Fold { .. }) => c.fold += 1,
                NodeKind::Terminal(Terminal::Showdown { .. }) => c.showdown += 1,
            }
        }
        c
    }
}

/// Public state threaded through the recursive build.
#[derive(Debug, Clone, Copy)]
struct State {
    street: Street,
    /// Total pot including chips bet on the current street.
    pot: f64,
    /// Chips behind, `[OOP, IP]`.
    stacks: [f64; 2],
    /// Chips put in on the current street, `[OOP, IP]`.
    bets: [f64; 2],
    to_act: u8,
    /// Whether anyone has acted on this street yet (so a check can close it).
    acted: bool,
    /// Raises made this street; the opening bet does not count.
    raises: u32,
    /// Size of the last bet/raise increment, i.e. the min-raise increment.
    last_raise: f64,
    /// Last aggressor on the current street.
    street_aggressor: Option<u8>,
    /// Last aggressor on the previous street; drives donk sizings.
    prev_aggressor: Option<u8>,
    board_mask: u64,
}

struct Builder<'a> {
    cfg: &'a SolveConfig,
    nodes: Vec<Node>,
}

impl Builder<'_> {
    fn push(&mut self, kind: NodeKind, pot: f64, stacks: [f64; 2], street: Street) -> u32 {
        // u32 child indices cap the arena. Reaching this needs ~4 billion nodes,
        // which exhausts memory long first; the assert only stops silent truncation.
        assert!(
            self.nodes.len() < NO_CHILD as usize,
            "game tree exceeded {NO_CHILD} nodes"
        );
        self.nodes.push(Node {
            kind,
            pot,
            stacks,
            street,
        });
        (self.nodes.len() - 1) as u32
    }

    /// Allocation-free placeholder kind, overwritten once children are built.
    fn placeholder() -> NodeKind {
        NodeKind::Decision {
            player: 0,
            actions: Vec::new(),
        }
    }

    /// A player to act.
    fn betting_node(&mut self, st: State) -> u32 {
        let p = st.to_act as usize;
        let o = 1 - p;
        let idx = self.push(Self::placeholder(), st.pot, st.stacks, st.street);

        let to_call = (st.bets[o] - st.bets[p]).clamp(0.0, st.stacks[p]);
        let facing = to_call > EPS;
        let mut actions: Vec<Action> = Vec::new();

        if facing {
            let child = self.fold_terminal(&st, to_call);
            actions.push(Action {
                label: ActionLabel::Fold,
                child,
            });
            let child = self.call_child(&st, to_call);
            actions.push(Action {
                label: ActionLabel::Call,
                child,
            });
        } else {
            let child = if st.acted {
                // Both players have now checked: the street is over.
                self.end_street(st)
            } else {
                let mut next = st;
                next.to_act = o as u8;
                next.acted = true;
                self.betting_node(next)
            };
            actions.push(Action {
                label: ActionLabel::Check,
                child,
            });
        }

        // Raising is capped per street; the opening bet of a street is never capped.
        let under_cap = !facing || st.raises < self.cfg.raise_cap;
        let can_aggress = under_cap && st.stacks[p] > to_call + EPS && st.stacks[o] > EPS;
        if can_aggress {
            for (is_allin, to) in self.sizing_amounts(&st) {
                let child = self.aggress_child(&st, to, facing);
                let label = if is_allin {
                    ActionLabel::AllIn
                } else if facing {
                    ActionLabel::Raise(to)
                } else {
                    ActionLabel::Bet(to)
                };
                actions.push(Action { label, child });
            }
        }

        self.nodes[idx as usize].kind = NodeKind::Decision {
            player: st.to_act,
            actions,
        };
        idx
    }

    /// Candidate street totals for the player to act: `(is_allin, to_amount)`,
    /// legality-floored, stack-capped, all-in-collapsed and deduplicated.
    fn sizing_amounts(&self, st: &State) -> Vec<(bool, f64)> {
        let p = st.to_act as usize;
        let o = 1 - p;
        let to_call = (st.bets[o] - st.bets[p]).max(0.0);
        let facing = to_call > EPS;

        let kind = if facing {
            SizingKind::Raise
        } else if st.to_act == 0 && st.prev_aggressor == Some(1) {
            // OOP leading into the player who was last aggressor on the previous street.
            SizingKind::Donk
        } else {
            SizingKind::Bet
        };
        let table = self.cfg.sizings_for(st.to_act, st.street, kind);

        let shove_to = st.bets[p] + st.stacks[p];
        let min_to = if facing {
            (st.bets[o] + st.last_raise.max(MIN_CHIP)).min(shove_to)
        } else {
            MIN_CHIP.min(shove_to)
        };
        let allin_at = self.cfg.allin_threshold / 100.0 * st.stacks[p];

        let mut out: Vec<(bool, f64)> = Vec::new();
        for &pct in &table.percents {
            if !pct.is_finite() || pct <= 0.0 {
                continue;
            }
            let raw = if facing {
                st.bets[o] + (st.pot + to_call) * pct / 100.0
            } else {
                st.bets[p] + st.pot * pct / 100.0
            };
            if !raw.is_finite() {
                continue;
            }
            let to = round_chips(raw).clamp(min_to, shove_to);
            let added = to - st.bets[p];
            if added <= EPS {
                continue;
            }
            if added + EPS >= allin_at || to >= shove_to - EPS {
                push_unique(&mut out, true, shove_to);
            } else {
                push_unique(&mut out, false, to);
            }
        }
        if table.allin {
            push_unique(&mut out, true, shove_to);
        }
        out
    }

    /// Child after betting or raising to `to` (a street total).
    fn aggress_child(&mut self, st: &State, to: f64, facing: bool) -> u32 {
        let p = st.to_act as usize;
        let o = 1 - p;
        let added = to - st.bets[p];
        let mut next = *st;
        next.bets[p] = to;
        next.stacks[p] = (st.stacks[p] - added).max(0.0);
        next.pot = st.pot + added;
        next.last_raise = to - st.bets[o];
        next.to_act = o as u8;
        next.acted = true;
        next.street_aggressor = Some(st.to_act);
        if facing {
            next.raises += 1;
        }
        self.betting_node(next)
    }

    /// Child after the player to act calls `to_call`.
    fn call_child(&mut self, st: &State, to_call: f64) -> u32 {
        let p = st.to_act as usize;
        let mut next = *st;
        next.bets[p] += to_call;
        next.stacks[p] = (st.stacks[p] - to_call).max(0.0);
        next.pot = st.pot + to_call;
        self.end_street(next)
    }

    /// Fold terminal. The uncalled bet goes back to the bettor.
    fn fold_terminal(&mut self, st: &State, uncalled: f64) -> u32 {
        let folder = st.to_act;
        let bettor = 1 - folder as usize;
        let mut stacks = st.stacks;
        stacks[bettor] += uncalled;
        let pot = st.pot - uncalled;
        self.push(
            NodeKind::Terminal(Terminal::Fold { folder, pot }),
            pot,
            stacks,
            st.street,
        )
    }

    /// Betting on `st.street` is finished and both players are in for the same amount.
    fn end_street(&mut self, st: State) -> u32 {
        debug_assert!(
            (st.bets[0] - st.bets[1]).abs() < EPS,
            "street ended with unmatched bets"
        );
        // Once either player is all in there is nothing left to bet: the remaining
        // streets are dealt straight to showdown.
        let all_in = st.stacks[0] <= EPS || st.stacks[1] <= EPS;
        match st.street.next() {
            None => self.push(
                NodeKind::Terminal(Terminal::Showdown { pot: st.pot }),
                st.pot,
                st.stacks,
                st.street,
            ),
            Some(next) => self.chance(st, next, all_in),
        }
    }

    /// Deal `next`. Every card not already on the board gets its own subtree.
    fn chance(&mut self, st: State, next: Street, betless: bool) -> u32 {
        let idx = self.push(Self::placeholder(), st.pot, st.stacks, next);
        // ponytail: one subtree per runout card, like every open solver. Collapsing
        // isomorphic runouts is the `iso` module's job, layered on top.
        let mut children = Box::new([NO_CHILD; NUM_CARDS]);
        for card in 0..NUM_CARDS as u8 {
            if st.board_mask & cards::card_mask(card) != 0 {
                continue;
            }
            let mut n = st;
            n.board_mask |= cards::card_mask(card);
            n.street = next;
            n.bets = [0.0; 2];
            n.to_act = 0;
            n.acted = false;
            n.raises = 0;
            n.last_raise = 0.0;
            n.prev_aggressor = st.street_aggressor;
            n.street_aggressor = None;
            children[card as usize] = if betless {
                self.end_street(n)
            } else {
                self.betting_node(n)
            };
        }
        self.nodes[idx as usize].kind = NodeKind::Chance {
            street: next,
            child_for_card: children,
        };
        idx
    }
}

/// Rounds a chip amount to the nearest 0.01.
fn round_chips(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn push_unique(out: &mut Vec<(bool, f64)>, is_allin: bool, to: f64) {
    if out.iter().any(|&(_, t)| (t - to).abs() < EPS) {
        return;
    }
    out.push((is_allin, to));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Sizings;

    const TOL: f64 = 1e-9;

    fn tree_of(cfg: &SolveConfig) -> GameTree {
        let board = cfg.board_cards().expect("board parses");
        cfg.validate().expect("config validates");
        GameTree::build(cfg, &board).expect("tree builds")
    }

    /// River, 100 behind into a pot of 10, one 50% bet for each player, no raises.
    fn river_cfg() -> SolveConfig {
        let mut cfg = SolveConfig {
            board: "As Kd 7h 2c 9s".to_string(),
            oop_range: "random".to_string(),
            ip_range: "random".to_string(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        cfg.sizings.oop.river.bet = Sizings::new(&[50.0], false);
        cfg.sizings.ip.river.bet = Sizings::new(&[50.0], false);
        cfg
    }

    fn labels(t: &GameTree, idx: u32) -> Vec<ActionLabel> {
        match &t.node(idx).kind {
            NodeKind::Decision { actions, .. } => actions.iter().map(|a| a.label).collect(),
            other => panic!("node {idx} is not a decision node: {other:?}"),
        }
    }

    fn follow(t: &GameTree, idx: u32, want: ActionLabel) -> u32 {
        match &t.node(idx).kind {
            NodeKind::Decision { actions, .. } => actions
                .iter()
                .find(|a| a.label == want)
                .unwrap_or_else(|| panic!("no {want:?} at node {idx}; have {:?}", labels(t, idx)))
                .child,
            other => panic!("node {idx} is not a decision node: {other:?}"),
        }
    }

    fn subtree(t: &GameTree, root: u32) -> Vec<u32> {
        let mut seen = Vec::new();
        let mut stack = vec![root];
        while let Some(i) = stack.pop() {
            seen.push(i);
            stack.extend(t.children(i));
        }
        seen
    }

    fn chance_children(t: &GameTree, idx: u32) -> Vec<u32> {
        match &t.node(idx).kind {
            NodeKind::Chance { child_for_card, .. } => child_for_card
                .iter()
                .copied()
                .filter(|&c| c != NO_CHILD)
                .collect(),
            other => panic!("node {idx} is not a chance node: {other:?}"),
        }
    }

    /// Every node keeps chips conserved, stacks non-negative and indices in range.
    fn assert_invariants(t: &GameTree, cfg: &SolveConfig) {
        let total = cfg.starting_pot + 2.0 * cfg.effective_stack;
        let board_len = t.board().len();
        for (i, node) in t.nodes().iter().enumerate() {
            assert!(node.pot >= -TOL, "node {i}: negative pot {}", node.pot);
            for p in 0..2 {
                assert!(
                    node.stacks[p] >= -TOL,
                    "node {i}: negative stack {}",
                    node.stacks[p]
                );
                assert!(
                    node.stacks[p] <= cfg.effective_stack + TOL,
                    "node {i}: stack above starting stack"
                );
            }
            let sum = node.pot + node.stacks[0] + node.stacks[1];
            assert!(
                (sum - total).abs() < 1e-6,
                "node {i}: chips not conserved ({sum} vs {total})"
            );
            match &node.kind {
                NodeKind::Decision { player, actions } => {
                    assert!(*player < 2, "node {i}: bad player {player}");
                    assert!(!actions.is_empty(), "node {i}: decision with no actions");
                    for a in actions {
                        assert!((a.child as usize) < t.len(), "node {i}: child out of range");
                    }
                }
                NodeKind::Chance {
                    street,
                    child_for_card,
                } => {
                    assert_eq!(*street, node.street);
                    let live = child_for_card.iter().filter(|&&c| c != NO_CHILD).count();
                    // Only cards already on the board at this node are dead.
                    assert_eq!(
                        live,
                        NUM_CARDS - (street.board_len() - 1),
                        "node {i}: wrong live card count"
                    );
                    assert!(street.board_len() > board_len);
                    for &c in child_for_card.iter().filter(|&&c| c != NO_CHILD) {
                        assert!((c as usize) < t.len(), "node {i}: card child out of range");
                    }
                }
                NodeKind::Terminal(_) => {}
            }
        }
    }

    #[test]
    fn river_one_bet_no_raises_has_exactly_nine_nodes() {
        let cfg = river_cfg();
        let t = tree_of(&cfg);

        // OOP: check / bet 5. IP after a check: check / bet 5. Each bet gets fold / call.
        assert_eq!(
            t.counts(),
            NodeCounts {
                decision: 4,
                chance: 0,
                fold: 2,
                showdown: 3,
                total: 9,
            }
        );
        assert_eq!(t.root(), 0);
        assert_eq!(t.node(0).street, Street::River);
        assert_eq!(labels(&t, 0), vec![ActionLabel::Check, ActionLabel::Bet(5.0)]);

        let ip_after_check = follow(&t, 0, ActionLabel::Check);
        assert_eq!(labels(&t, ip_after_check), vec![ActionLabel::Check, ActionLabel::Bet(5.0)]);

        // check / check goes straight to showdown for the starting pot
        let sd = follow(&t, ip_after_check, ActionLabel::Check);
        match t.node(sd).kind {
            NodeKind::Terminal(Terminal::Showdown { pot }) => assert!((pot - 10.0).abs() < TOL),
            ref other => panic!("expected showdown, got {other:?}"),
        }

        assert_invariants(&t, &cfg);
    }

    #[test]
    fn fold_terminal_pot_is_the_matched_chips() {
        let cfg = river_cfg();
        let t = tree_of(&cfg);

        // OOP checks, IP bets 5, OOP folds: IP's uncalled 5 comes back, pot is the 10.
        let ip = follow(&t, 0, ActionLabel::Check);
        let oop_facing = follow(&t, ip, ActionLabel::Bet(5.0));
        assert!((t.node(oop_facing).pot - 15.0).abs() < TOL);
        assert!((t.node(oop_facing).stacks[1] - 95.0).abs() < TOL);

        let folded = follow(&t, oop_facing, ActionLabel::Fold);
        match t.node(folded).kind {
            NodeKind::Terminal(Terminal::Fold { folder, pot }) => {
                assert_eq!(folder, 0);
                assert!((pot - 10.0).abs() < TOL, "matched pot was {pot}");
            }
            ref other => panic!("expected fold, got {other:?}"),
        }
        assert!((t.node(folded).stacks[1] - 100.0).abs() < TOL, "uncalled bet returned");

        // Calling instead contests 20.
        let called = follow(&t, oop_facing, ActionLabel::Call);
        match t.node(called).kind {
            NodeKind::Terminal(Terminal::Showdown { pot }) => assert!((pot - 20.0).abs() < TOL),
            ref other => panic!("expected showdown, got {other:?}"),
        }
    }

    #[test]
    fn raise_cap_is_honored() {
        let mut cfg = river_cfg();
        cfg.raise_cap = 1;
        cfg.sizings.oop.river.raise = Sizings::new(&[100.0], false);
        cfg.sizings.ip.river.raise = Sizings::new(&[100.0], false);
        let t = tree_of(&cfg);

        // OOP checks, IP bets 5 into 10, OOP raises to 5 + (15 + 5) = 25.
        let ip = follow(&t, 0, ActionLabel::Check);
        let oop_facing = follow(&t, ip, ActionLabel::Bet(5.0));
        assert_eq!(
            labels(&t, oop_facing),
            vec![ActionLabel::Fold, ActionLabel::Call, ActionLabel::Raise(25.0)]
        );

        // One raise is the cap: IP may only fold or call.
        let ip_facing_raise = follow(&t, oop_facing, ActionLabel::Raise(25.0));
        assert_eq!(
            labels(&t, ip_facing_raise),
            vec![ActionLabel::Fold, ActionLabel::Call]
        );
        assert_invariants(&t, &cfg);
    }

    #[test]
    fn allin_threshold_collapses_a_ninety_percent_sizing() {
        // Pot 100, stack 100: a 90%-pot bet is 90% of the shove.
        let mut cfg = river_cfg();
        cfg.starting_pot = 100.0;
        cfg.sizings.oop.river.bet = Sizings::new(&[90.0], false);
        cfg.sizings.ip.river.bet = Sizings::default();

        cfg.allin_threshold = 67.0;
        let t = tree_of(&cfg);
        assert_eq!(labels(&t, 0), vec![ActionLabel::Check, ActionLabel::AllIn]);
        let shoved = follow(&t, 0, ActionLabel::AllIn);
        assert!((t.node(shoved).pot - 200.0).abs() < TOL);
        assert_eq!(t.node(shoved).stacks[0], 0.0);
        assert!((t.node(shoved).stacks[1] - 100.0).abs() < TOL);
        assert_invariants(&t, &cfg);

        // Above the threshold the sizing survives as its own action.
        cfg.allin_threshold = 95.0;
        let t = tree_of(&cfg);
        assert_eq!(labels(&t, 0), vec![ActionLabel::Check, ActionLabel::Bet(90.0)]);
        assert_invariants(&t, &cfg);
    }

    #[test]
    fn donk_table_is_used_when_oop_leads_into_the_previous_aggressor() {
        let mut cfg = SolveConfig {
            board: "As Kd 7h".to_string(),
            oop_range: "random".to_string(),
            ip_range: "random".to_string(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        cfg.sizings.ip.flop.bet = Sizings::new(&[50.0], false);
        cfg.sizings.oop.turn.bet = Sizings::new(&[75.0], false);
        cfg.sizings.oop.turn.donk = Sizings::new(&[25.0], false);
        let t = tree_of(&cfg);

        // OOP checks, IP bets 5, OOP calls: pot 20, IP was the flop aggressor.
        let ip = follow(&t, 0, ActionLabel::Check);
        let oop_facing = follow(&t, ip, ActionLabel::Bet(5.0));
        let turn_chance = follow(&t, oop_facing, ActionLabel::Call);
        assert!((t.node(turn_chance).pot - 20.0).abs() < TOL);
        let turn_first = chance_children(&t, turn_chance)[0];
        // 25% of 20 = 5 (donk table), not 15 (bet table).
        assert_eq!(
            labels(&t, turn_first),
            vec![ActionLabel::Check, ActionLabel::Bet(5.0)]
        );

        // Check / check through the flop leaves no previous aggressor: bet table.
        let checked_through = follow(&t, ip, ActionLabel::Check);
        let turn_first = chance_children(&t, checked_through)[0];
        assert_eq!(
            labels(&t, turn_first),
            vec![ActionLabel::Check, ActionLabel::Bet(7.5)]
        );
        assert_invariants(&t, &cfg);
    }

    #[test]
    fn flop_chance_nodes_deal_49_turns_and_48_rivers() {
        // No sizings at all: a legal check-down tree, small enough to count by hand.
        let cfg = SolveConfig {
            board: "As Kd 7h".to_string(),
            oop_range: "random".to_string(),
            ip_range: "random".to_string(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            ..SolveConfig::default()
        };
        let t = tree_of(&cfg);

        let turn_chance = follow(&t, follow(&t, 0, ActionLabel::Check), ActionLabel::Check);
        assert_eq!(t.node(turn_chance).street, Street::Turn);
        let turns = chance_children(&t, turn_chance);
        assert_eq!(turns.len(), 49);
        for &turn in &turns {
            let river_chance = follow(&t, follow(&t, turn, ActionLabel::Check), ActionLabel::Check);
            assert_eq!(t.node(river_chance).street, Street::River);
            assert_eq!(chance_children(&t, river_chance).len(), 48);
        }

        // 2 flop decisions + 1 turn chance + 49 * (2 + 1 + 48 * 3)
        assert_eq!(
            t.counts(),
            NodeCounts {
                decision: 2 + 49 * (2 + 48 * 2),
                chance: 1 + 49,
                fold: 0,
                showdown: 49 * 48,
                total: 7206,
            }
        );
        assert_invariants(&t, &cfg);
    }

    #[test]
    fn allin_before_the_river_runs_out_with_no_betting() {
        let mut cfg = SolveConfig {
            board: "As Kd 7h".to_string(),
            oop_range: "random".to_string(),
            ip_range: "random".to_string(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            ..SolveConfig::default()
        };
        cfg.sizings.oop.flop.bet = Sizings::new(&[], true);
        let t = tree_of(&cfg);

        let ip_facing = follow(&t, 0, ActionLabel::AllIn);
        // Calling a shove is exactly all-in with equal effective stacks: no raise.
        assert_eq!(labels(&t, ip_facing), vec![ActionLabel::Fold, ActionLabel::Call]);

        let runout = follow(&t, ip_facing, ActionLabel::Call);
        assert_eq!(t.node(runout).street, Street::Turn);
        let nodes = subtree(&t, runout);
        // 1 turn chance + 49 * (1 river chance + 48 showdowns)
        assert_eq!(nodes.len(), 1 + 49 * 49);
        for &i in &nodes {
            assert!(
                !matches!(t.node(i).kind, NodeKind::Decision { .. }),
                "node {i} still has betting after the all-in"
            );
            assert_eq!(t.node(i).stacks, [0.0, 0.0]);
        }
        assert_eq!(
            nodes
                .iter()
                .filter(|&&i| matches!(t.node(i).kind, NodeKind::Terminal(_)))
                .count(),
            49 * 48
        );
        assert_invariants(&t, &cfg);
    }

    #[test]
    fn raise_below_the_min_raise_is_floored() {
        let mut cfg = river_cfg();
        cfg.raise_cap = 2;
        // 1% of pot would be a raise to 5.2, which is not a legal raise over a
        // bet of 5. It comes up to the min-raise of 10.
        cfg.sizings.oop.river.raise = Sizings::new(&[1.0], false);
        let t = tree_of(&cfg);

        let ip = follow(&t, 0, ActionLabel::Check);
        let oop_facing = follow(&t, ip, ActionLabel::Bet(5.0));
        assert_eq!(
            labels(&t, oop_facing),
            vec![ActionLabel::Fold, ActionLabel::Call, ActionLabel::Raise(10.0)]
        );
        assert_invariants(&t, &cfg);
    }

    #[test]
    fn sizings_are_capped_at_the_stack() {
        let mut cfg = river_cfg();
        // 10000% of pot is far more than the 100 behind: it caps out as the shove.
        cfg.sizings.ip.river.bet = Sizings::new(&[10000.0], false);
        let t = tree_of(&cfg);

        let ip = follow(&t, 0, ActionLabel::Check);
        assert_eq!(labels(&t, ip), vec![ActionLabel::Check, ActionLabel::AllIn]);
        let shoved = follow(&t, ip, ActionLabel::AllIn);
        assert!((t.node(shoved).pot - 110.0).abs() < TOL);
        assert_eq!(t.node(shoved).stacks[1], 0.0);
        // OOP owes its entire stack, so it can only fold or call.
        assert_eq!(labels(&t, shoved), vec![ActionLabel::Fold, ActionLabel::Call]);
        assert_invariants(&t, &cfg);
    }

    /// A line names a node the way a hand history does, and every token
    /// [`ActionLabel::token`] writes is a token [`GameTree::resolve_line`] reads back.
    #[test]
    fn lines_resolve_to_the_nodes_they_name() {
        let cfg = river_cfg();
        let t = tree_of(&cfg);

        let ip = follow(&t, 0, ActionLabel::Check);
        let facing = follow(&t, ip, ActionLabel::Bet(5.0));
        for (line, want) in [
            ("", 0),
            ("check", ip),
            ("check,bet:5", facing),
            ("  check , bet : 5 ", facing),
            ("CHECK,Bet:5.00", facing),
            // The amount may be dropped when the node offers exactly one bet.
            ("check,bet", facing),
            ("check,bet:5,fold", follow(&t, facing, ActionLabel::Fold)),
        ] {
            assert_eq!(t.resolve_line(line).expect(line), want, "line {line:?}");
        }

        // Round trip: the token form of every action at a node resolves back to it.
        for label in labels(&t, 0) {
            let line = label.token();
            assert_eq!(t.resolve_line(&line).expect(&line), follow(&t, 0, label));
        }
        assert_eq!(labels(&t, 0)[1].token(), "bet:5");

        for (line, needle) in [
            ("shove", "unknown action"),
            ("check,bet:7", "is not offered"),
            ("check,check,check", "past the end of the hand"),
            ("check,Ah", "unknown action"),
            ("check,,bet:5", "is empty"),
            ("check:2", "takes no amount"),
            ("bet:x", "bad amount"),
        ] {
            let err = t.resolve_line(line).expect_err(line);
            assert!(err.contains(needle), "line {line:?}: wanted {needle:?}, got {err}");
        }
    }

    /// A chance node consumes the dealt card, so a line can name a node on any runout.
    #[test]
    fn lines_step_through_chance_nodes_by_card() {
        let cfg = SolveConfig {
            board: "As Kd 7h".to_string(),
            oop_range: "random".to_string(),
            ip_range: "random".to_string(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            ..SolveConfig::default()
        };
        let t = tree_of(&cfg);

        let turn_chance = follow(&t, follow(&t, 0, ActionLabel::Check), ActionLabel::Check);
        let node = t.resolve_line("check,check,2c").expect("line resolves");
        assert_eq!(node, chance_children(&t, turn_chance)[0]);
        assert_eq!(t.node(node).street, Street::Turn);
        assert!(t.resolve_line("check,check,2c,check,check,3c").is_ok(), "a line may run to the river");

        // A card already on the board was never dealt here, and a decision node does not
        // take a card.
        let err = t.resolve_line("check,check,As").unwrap_err();
        assert!(err.contains("already on the board"), "{err}");
        let err = t.resolve_line("check,check,2c,2c").unwrap_err();
        assert!(err.contains("unknown action"), "{err}");
    }

    /// A lock names its player, and a line that lands on the other player's node — or on
    /// no decision node at all — is a config bug, not something to freeze quietly.
    #[test]
    fn resolve_lock_cross_checks_the_acting_player() {
        let cfg = river_cfg();
        let t = tree_of(&cfg);
        let lock = |line: &str, player: u8| NodeLock {
            line: line.to_string(),
            player,
            freqs: Some(vec![1.0, 0.0]),
            strategy: None,
        };

        assert_eq!(t.resolve_lock(&lock("", 0)).expect("root is OOP's"), (0, 2));
        let (node, n_act) = t.resolve_lock(&lock("check", 1)).expect("IP acts after a check");
        assert_eq!((node, n_act), (follow(&t, 0, ActionLabel::Check), 2));

        for (line, player, needle) in [
            ("", 1, "where player 0 acts, not player 1"),
            ("check", 0, "where player 1 acts, not player 0"),
            ("check,check", 0, "a terminal"),
        ] {
            let err = t.resolve_lock(&lock(line, player)).expect_err(line);
            assert!(err.contains(needle), "line {line:?}: wanted {needle:?}, got {err}");
        }
    }

    #[test]
    fn build_rejects_a_bad_board() {
        let cfg = river_cfg();
        assert!(GameTree::build(&cfg, &[0, 1]).is_err());
        assert!(GameTree::build(&cfg, &[0, 0, 1]).is_err());
    }
}
