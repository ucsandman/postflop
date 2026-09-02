//! The real heads-up NLHE postflop game: [`NlheGame`] implements [`Game`] over a
//! [`GameTree`] plus two parsed ranges, so [`crate::cfr::Solver`] and [`crate::br`]
//! run on it unchanged.
//!
//! # What is precomputed, and why
//!
//! Everything the iteration touches is built once in [`NlheGame::new`]:
//!
//! * **Board data, keyed by board mask.** Every node carries the board *known at that
//!   node*; nodes on the same board share one [`BoardData`] holding that board's live
//!   hands, their 1326-indices, and (on a 5-card board) the [`SortedRanks`] both sides
//!   show down with. Keying on the *mask* also collapses turn/river orderings, so a flop
//!   tree has `1 + 49 + C(49,2) = 1226` distinct boards — not `1 + 49 + 49*48` — no
//!   matter how big the betting tree on top of them is.
//! * **Chance maps, keyed by the *parent* board.** The combo set a dealt card leaves
//!   behind depends only on (board so far, card) — never on the betting line — so all
//!   turn chance nodes in a flop tree share the same 49 maps per player, and all river
//!   chance nodes under turn card `t` share the same 48. That is `49 + 49*48` map
//!   groups instead of one copy per chance node, which is where naive implementations
//!   run out of memory. [`NlheGame::chance_map_bytes`] reports the real figure.
//! * **Terminal payoffs.** Two `f64` per terminal per player (see the algebra below),
//!   so [`Game::terminal_utility`] is one call into [`crate::terminal`] with no
//!   allocation and no `eval7` in the hot path.
//!
//! Dead combos are filtered out, never zero-weighted: a combo whose weight is `0` in
//! the range string is absent from the root vector entirely, and a combo a runout card
//! kills is absent from that subtree's vector.
//!
//! # Chance weights are conditional
//!
//! A deal from `n` unseen cards weighs each outcome `1/(n-4)`, not `1/n`. Every
//! compatible combo pair holds four cards that are not on the board, so exactly four of
//! those `n` outcomes are dead for it and the other `n-4` each carry `1/(n-4)`: **one
//! unit of runout mass per pair, at every chance depth**. That is what makes a terminal
//! above a chance node and a terminal below one directly comparable, which the CFR
//! traversal assumes when it compares sibling actions. Uniform `1/n` weights leave a pair
//! only `(n-4)/n` of a unit below each deal while a flop fold keeps a full unit, which
//! over-values fold equity by `(49*48)/(45*44)` — about 19% — on a flop solve and by
//! `48/44` on a turn solve, and no single global rescale can fix two chance depths at
//! once. Corrected 2026-09-01; see
//! `one_compatible_pair_accumulates_exactly_one_unit_of_runout_mass`.
//!
//! The consequence for [`Game::normalizer`] is that it is plain joint root mass: the deal
//! weights contribute exactly `1`, so there is nothing to correct for.
//!
//! # Payoff algebra (net chips, exactly zero-sum)
//!
//! Write `S` for `starting_pot`, `E` for `effective_stack`. At any node the tree
//! guarantees `pot + stacks[0] + stacks[1] == S + 2E`, so player `p`'s postflop
//! contribution is `c_p = E - stacks[p]` and the terminal pot is `P = S + c_0 + c_1`.
//!
//! The convention in [`crate::game`] is *net chips vs the start of the solve*, with the
//! starting pot credited half to each player. So each player's **stake** — the chips
//! that are theirs and at risk in the middle — is
//!
//! ```text
//! stake_p = S/2 + c_p        and        stake_0 + stake_1 = P
//! ```
//!
//! That identity is the whole proof. Whoever is awarded the (post-rake) pot nets
//! `P - rake - stake`, whoever is awarded nothing nets `-stake`, and for any joint
//! combo pair
//!
//! ```text
//! u_win + u_lose = (P - rake - stake_w) + (-stake_l) = P - rake - P = -rake
//! ```
//!
//! which is `0` rake-free. A chop pays `(P - rake)/2 - stake`, i.e. the rake is split
//! evenly. That equals `(win + lose)/2`, but [`terminal::showdown_ev_ranked`] takes the
//! chop payoff as its own parameter rather than deriving it, so [`TermData`] carries
//! `chop` alongside `win`/`lose` and states the midpoint explicitly. Under a linear
//! chip payoff the two are the same number; under a non-linear payoff map they are
//! not, and only the explicit form can express it.
//!
//! Since both players are matched at every terminal the tree produces (`c_0 == c_1`,
//! the uncalled bet already back in the bettor's stack), `stake = P/2` and the rake-free
//! numbers reduce to `win = P/2`, `lose = -P/2`. The general form is used anyway: it
//! costs nothing and does not assume the tree only ever builds matched terminals.
//!
//! **Rake makes the game constant-sum, not zero-sum**: the two utilities sum to
//! `-rake` instead of `0`, so `br::exploitability` is offset by the expected rake and
//! no longer bottoms out at zero. Measure convergence against that shifted baseline, or
//! solve rake-free. The milestone tests are rake-free.
//!
//! # Tournament payoffs (ICM), and why they are general-sum
//!
//! With a `[tournament]` block ([`crate::config::Tournament`]) the payoff at a terminal
//! is not chips but the change in the seat's **tournament equity**. Write `stacks` for
//! the chips behind every seat at the root of this node, `S` for `starting_pot` and
//! `eq` for [`crate::icm::equity`]. Then, once per game:
//!
//! ```text
//! scale = (sum(stacks) + S) / sum(payouts)     // chips at the table per payout unit
//! base  = stacks, with S/2 added to each in-hand seat  // the same re-centering
//! root  = eq(base, payouts)                    // computed once, not per terminal
//! ```
//!
//! and at each terminal, for each of the three outcomes (player 0 awarded the pot,
//! player 1 awarded it, split), the two in-hand seats end with `stacks[seat] - c_p`
//! plus their award, every other seat is untouched, and
//!
//! ```text
//! payoff_p = (eq(final, payouts)[seat_p] - root[seat_p]) * scale
//! ```
//!
//! `scale` puts the answer back on a chip axis - **CSTE**, chip-scaled tournament
//! equity - so pot percentages, the i16 quantizer and every existing display stay
//! dimensionally sane. Under winner-take-all `eq` is exactly chip-proportional and
//! `scale` cancels it, so the payoff collapses to `award - stake_p`: the chip game,
//! reached by a different arithmetic path.
//!
//! Three consequences, all deliberate:
//!
//! * **The chop is not the midpoint.** `eq` is concave in chips, so splitting a pot is
//!   worth strictly more than half of winning it plus half of losing it. That is why
//!   [`TermData`] states `chop` rather than deriving it; under chips the two agree.
//! * **The game is general-sum.** Chips moving between two seats changes the frozen
//!   field's equity too, so `u0(i,j) + u1(j,i)` is negative and *varies* with how many
//!   chips moved. [`Game::zero_sum`] returns `false` and `br::exploitability` reports
//!   NashConv; see the `br` module docs for what that does and does not certify.
//! * **The covering seat's excess never enters the tree.** An all-in is capped at
//!   `effective_stack`, so `stacks[seat] - effective_stack` rides through every
//!   terminal as a constant added to that seat's final stack. Only the ICM vector sees
//!   it. Per-seat stacks *inside* the tree (side pots) remain a separate project.

use std::collections::HashMap;

use crate::br::{self, StrategyProfile};
use crate::cards::{self, Card, NUM_CARDS};
use crate::config::SolveConfig;
use crate::game::{ChanceEdge, Game, NodeInfo};
use crate::icm;
use crate::range::Range;
use crate::terminal::{self, Hand, SortedRanks};
use crate::tree::{GameTree, Node, NodeKind, Terminal as TreeTerminal, NO_CHILD};

/// Sentinel for "this node has no side-table entry".
const NONE: u32 = u32::MAX;

/// One distinct board reached somewhere in the tree, with both players' live combos on
/// it. Shared by every node that sees this board.
#[derive(Debug)]
struct BoardData {
    board: Vec<Card>,
    /// Live hands per player, a subsequence of the root list in canonical ascending
    /// combo order.
    hands: [Vec<Hand>; 2],
    /// The canonical 1326-combo index of each entry of `hands`.
    indices: [Vec<u32>; 2],
    /// Showdown rankings, present only on a complete 5-card board.
    ranks: [Option<SortedRanks>; 2],
}

/// `parent_of_child` for one dealt card, per player. Empty when the card is dead.
#[derive(Debug, Default, Clone)]
struct CardMap([Vec<u32>; 2]);

#[derive(Debug)]
struct ChanceData {
    /// Board id *before* the deal — the board this node's combo vectors live on.
    board: u32,
    /// `(dealt card, child node)`, ascending by card.
    outcomes: Vec<(Card, u32)>,
    weight: f32,
}

#[derive(Debug)]
struct TermData {
    board: u32,
    /// `Some(p)` when player `p` folded, `None` at a showdown.
    folder: Option<u8>,
    /// Net chips to player `p` when `p` is awarded the post-rake pot.
    win: [f64; 2],
    /// Net chips to player `p` when `p` is awarded nothing.
    lose: [f64; 2],
    /// Net chips to player `p` when the pot is split. Stated, not derived from
    /// `win`/`lose`: see the module docs.
    chop: [f64; 2],
}

/// Everything the ICM payoff branch needs, built once in [`NlheGame::new`].
///
/// Absent for a chip solve, in which case nothing here is ever consulted and the
/// original payoff arithmetic runs unchanged. See the module docs for the algebra.
#[derive(Debug)]
struct Icm {
    /// Chips at the table divided by the prize pool. Multiplying an equity delta in
    /// payout units by this puts it back on a chip axis (CSTE).
    scale: f64,
    /// Every seat's equity at the root of this solve, in payout units. Subtracted at
    /// every terminal so payoffs stay net vs. the start of the solve, exactly as the
    /// chip convention is.
    root: Vec<f64>,
    /// `[OOP, IP]` indices into `stacks`.
    seats: [usize; 2],
    /// Chips behind per seat at the root of this node, straight from the config.
    stacks: Vec<f64>,
    payouts: Vec<f64>,
}

impl Icm {
    fn new(cfg: &SolveConfig, t: &crate::config::Tournament) -> Icm {
        let chips: f64 = t.stacks.iter().sum::<f64>() + cfg.starting_pot;
        let pool: f64 = t.payouts.iter().sum();
        // The same re-centering the chip convention uses: the starting pot is credited
        // half to each player, so "no chips moved" means "equity unchanged".
        let mut base = t.stacks.clone();
        for &seat in &t.seats {
            base[seat] += cfg.starting_pot * 0.5;
        }
        Icm {
            scale: chips / pool,
            root: icm::equity(&base, &t.payouts),
            seats: t.seats,
            stacks: t.stacks.clone(),
            payouts: t.payouts.clone(),
        }
    }

    /// Payoff to each in-hand seat, in CSTE chips, when the two of them leave this
    /// terminal with `behind` chips each and every other seat is untouched.
    fn payoff(&self, behind: [f64; 2]) -> [f64; 2] {
        let mut fin = self.stacks.clone();
        fin[self.seats[0]] = behind[0];
        fin[self.seats[1]] = behind[1];
        let eq = icm::equity(&fin, &self.payouts);
        [
            (eq[self.seats[0]] - self.root[self.seats[0]]) * self.scale,
            (eq[self.seats[1]] - self.root[self.seats[1]]) * self.scale,
        ]
    }
}

/// A solvable heads-up NLHE postflop spot.
#[derive(Debug)]
pub struct NlheGame {
    cfg: SolveConfig,
    tree: GameTree,
    boards: Vec<BoardData>,
    /// Board id per node.
    node_board: Vec<u32>,
    /// Cached [`NodeInfo`] per node, so `node()` is one array read.
    info: Vec<NodeInfo>,
    /// Index into `chance` or `terms` (disambiguated by `info`), or [`NONE`].
    node_aux: Vec<u32>,
    chance: Vec<ChanceData>,
    terms: Vec<TermData>,
    /// Parent board id -> 52 per-card maps. One entry per board that is dealt from.
    maps: HashMap<u32, Vec<CardMap>>,
    root_weights: [Vec<f32>; 2],
    normalizer: f32,
    /// Present exactly when `cfg.tournament` is. Also the flag [`Game::zero_sum`]
    /// reads, so the two can never disagree.
    icm: Option<Icm>,
    /// Node id -> index into `locks`, or [`NONE`]. **Empty** when the config locks
    /// nothing, which is what keeps an unlocked solve free of a per-node table.
    lock_at: Vec<u32>,
    /// `(node, frozen strategy)` per `cfg.locks` entry, in config order.
    locks: Vec<(u32, Vec<f32>)>,
}

/// `"random"` (any case) means the full 1326-combo range; anything else is standard
/// range notation.
fn parse_range(s: &str) -> Result<Range, String> {
    if s.trim().eq_ignore_ascii_case("random") {
        Ok(Range::uniform_full())
    } else {
        Range::parse(s)
    }
}

#[inline]
fn hand_mask(h: Hand) -> u64 {
    cards::card_mask(h.0) | cards::card_mask(h.1)
}

impl NlheGame {
    /// Parses the board and both ranges, builds the tree, and precomputes every table
    /// the CFR iteration reads.
    pub fn new(cfg: &SolveConfig) -> Result<NlheGame, String> {
        cfg.validate()?;
        let board = cfg.board_cards()?;
        let root_mask = cards::mask_of(&board);
        let tree = GameTree::build(cfg, &board)?;

        // --- root combo sets: live on the board AND carrying positive weight -------
        let ranges = [
            parse_range(&cfg.oop_range).map_err(|e| format!("oop_range: {e}"))?,
            parse_range(&cfg.ip_range).map_err(|e| format!("ip_range: {e}"))?,
        ];
        let mut root_hands: [Vec<Hand>; 2] = [Vec::new(), Vec::new()];
        let mut root_indices: [Vec<u32>; 2] = [Vec::new(), Vec::new()];
        let mut root_weights: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
        for p in 0..2 {
            for c in ranges[p].live_on(root_mask).combos {
                if c.weight <= 0.0 {
                    continue;
                }
                root_hands[p].push(c.cards);
                root_indices[p].push(c.index as u32);
                root_weights[p].push(c.weight);
            }
            if root_hands[p].is_empty() {
                let who = if p == 0 { "oop_range" } else { "ip_range" };
                return Err(format!("{who} has no combos left after board filtering"));
            }
        }

        // --- walk the tree, assigning a board id to every node ---------------------
        let n = tree.len();
        let mut node_board = vec![NONE; n];
        let mut board_masks: Vec<(u64, Vec<Card>)> = vec![(root_mask, board.clone())];
        let mut by_mask: HashMap<u64, u32> = HashMap::from([(root_mask, 0u32)]);
        let mut info = vec![NodeInfo::Terminal; n];
        let mut node_aux = vec![NONE; n];
        let mut chance: Vec<ChanceData> = Vec::new();
        let mut terms: Vec<TermData> = Vec::new();
        // Built once, before the walk: the root equity vector is the same for every
        // terminal, and re-deriving it per terminal would triple the DP cost.
        let icm = cfg.tournament.as_ref().map(|t| Icm::new(cfg, t));

        let mut stack = vec![(tree.root(), 0u32)];
        while let Some((idx, b)) = stack.pop() {
            node_board[idx as usize] = b;
            let node: &Node = tree.node(idx);
            match &node.kind {
                NodeKind::Decision { player, actions } => {
                    info[idx as usize] = NodeInfo::Decision {
                        player: *player,
                        num_actions: actions.len(),
                    };
                    for a in actions {
                        stack.push((a.child, b));
                    }
                }
                NodeKind::Chance { child_for_card, .. } => {
                    let mut outcomes = Vec::new();
                    for (card, &child) in child_for_card.iter().enumerate() {
                        if child == NO_CHILD {
                            continue;
                        }
                        let m = board_masks[b as usize].0 | cards::card_mask(card as Card);
                        let child_board = match by_mask.get(&m) {
                            Some(&id) => id,
                            None => {
                                let id = board_masks.len() as u32;
                                let mut cb = board_masks[b as usize].1.clone();
                                cb.push(card as Card);
                                board_masks.push((m, cb));
                                by_mask.insert(m, id);
                                id
                            }
                        };
                        outcomes.push((card as Card, child));
                        stack.push((child, child_board));
                    }
                    info[idx as usize] = NodeInfo::Chance {
                        num_outcomes: outcomes.len(),
                    };
                    node_aux[idx as usize] = chance.len() as u32;
                    // CONDITIONAL deal weight: `1/(outcomes - 4)`, not `1/outcomes`.
                    // Every compatible pair holds four cards that are not on the board,
                    // so exactly four of these outcomes are dead for it and the other
                    // `outcomes - 4` each carry `1/(outcomes - 4)` — one unit of runout
                    // mass per pair, at every chance depth. A uniform `1/outcomes` leaves
                    // each pair only `(outcomes-4)/outcomes` of a unit, which is not the
                    // same number at two different depths, so terminals above and below a
                    // chance node end up on different scales. See
                    // `one_compatible_pair_accumulates_exactly_one_unit_of_runout_mass`.
                    chance.push(ChanceData {
                        board: b,
                        weight: 1.0 / (outcomes.len() - 4) as f32,
                        outcomes,
                    });
                }
                NodeKind::Terminal(t) => {
                    info[idx as usize] = NodeInfo::Terminal;
                    node_aux[idx as usize] = terms.len() as u32;
                    terms.push(Self::term_data(cfg, icm.as_ref(), node, t, b));
                }
            }
        }

        // --- board data ------------------------------------------------------------
        let boards: Vec<BoardData> = board_masks
            .into_iter()
            .map(|(mask, cards_on_board)| {
                let extra = mask & !root_mask;
                let mut hands: [Vec<Hand>; 2] = [Vec::new(), Vec::new()];
                let mut indices: [Vec<u32>; 2] = [Vec::new(), Vec::new()];
                for p in 0..2 {
                    for (k, &h) in root_hands[p].iter().enumerate() {
                        if hand_mask(h) & extra == 0 {
                            hands[p].push(h);
                            indices[p].push(root_indices[p][k]);
                        }
                    }
                }
                let ranks = if cards_on_board.len() == 5 {
                    let b5: [Card; 5] = cards_on_board[..5].try_into().expect("5 cards");
                    [
                        Some(SortedRanks::new(&b5, &hands[0])),
                        Some(SortedRanks::new(&b5, &hands[1])),
                    ]
                } else {
                    [None, None]
                };
                BoardData {
                    board: cards_on_board,
                    hands,
                    indices,
                    ranks,
                }
            })
            .collect();

        // --- chance maps, one group per board that is ever dealt from --------------
        let mut maps: HashMap<u32, Vec<CardMap>> = HashMap::new();
        for c in &chance {
            if maps.contains_key(&c.board) {
                continue;
            }
            let parent = &boards[c.board as usize];
            let mut per_card = vec![CardMap::default(); NUM_CARDS];
            for &(card, _) in &c.outcomes {
                let dead = cards::card_mask(card);
                let mut m = CardMap::default();
                for p in 0..2 {
                    m.0[p] = parent.hands[p]
                        .iter()
                        .enumerate()
                        .filter(|(_, &h)| hand_mask(h) & dead == 0)
                        .map(|(k, _)| k as u32)
                        .collect();
                }
                per_card[card as usize] = m;
            }
            maps.insert(c.board, per_card);
        }

        // --- normalizer ------------------------------------------------------------
        // Joint root mass over compatible pairs: fold_ev at payoff 1 gives, per hero
        // combo, exactly the opponent weight that shares no card with it. No runout
        // correction: the conditional deal weights above give every pair exactly one
        // unit of chance mass, whatever the board length.
        let mut compat = vec![0.0f32; root_hands[0].len()];
        terminal::fold_ev(
            &root_hands[0],
            &root_hands[1],
            &root_weights[1],
            1.0,
            &mut compat,
        );
        let joint: f64 = root_weights[0]
            .iter()
            .zip(&compat)
            .map(|(&w, &m)| w as f64 * m as f64)
            .sum();
        let normalizer = joint as f32;

        // --- node locks ------------------------------------------------------------
        // Resolved here rather than in `SolveConfig::validate` because a line only means
        // something against a built tree, and the combo axis only against the boards.
        let mut lock_at = Vec::new();
        let mut locks: Vec<(u32, Vec<f32>)> = Vec::new();
        if !cfg.locks.is_empty() {
            lock_at = vec![NONE; n];
            for (i, lock) in cfg.locks.iter().enumerate() {
                let tag = format!("locks[{i}] (line {:?})", lock.line);
                let (node, num_actions) =
                    tree.resolve_lock(lock).map_err(|e| format!("{tag}: {e}"))?;
                if lock_at[node as usize] != NONE {
                    return Err(format!("{tag}: node {node} is already locked by an earlier entry"));
                }
                let combos = boards[node_board[node as usize] as usize].hands
                    [lock.player as usize]
                    .len();
                let strategy = lock
                    .expand(num_actions, combos)
                    .map_err(|e| format!("{tag}: {e}"))?;
                lock_at[node as usize] = locks.len() as u32;
                locks.push((node, strategy));
            }
        }

        Ok(NlheGame {
            cfg: cfg.clone(),
            tree,
            boards,
            node_board,
            info,
            node_aux,
            chance,
            terms,
            maps,
            root_weights,
            normalizer,
            icm,
            lock_at,
            locks,
        })
    }

    /// Terminal payoffs. See the module docs for both derivations.
    fn term_data(
        cfg: &SolveConfig,
        icm: Option<&Icm>,
        node: &Node,
        t: &TreeTerminal,
        board: u32,
    ) -> TermData {
        let pot = node.pot;
        let net = pot - cfg.rake.amount(pot);
        let (win, lose, chop) = match icm {
            // Chips. The original branch, untouched.
            None => {
                // stake_p = starting_pot/2 + postflop contribution of p.
                let stake = [
                    cfg.starting_pot * 0.5 + (cfg.effective_stack - node.stacks[0]),
                    cfg.starting_pot * 0.5 + (cfg.effective_stack - node.stacks[1]),
                ];
                let win = [net - stake[0], net - stake[1]];
                let lose = [-stake[0], -stake[1]];
                // Half the post-rake pot, minus the stake. The same f64 midpoint
                // `showdown_ev_ranked` used to compute internally, moved out here.
                let chop = [(win[0] + lose[0]) * 0.5, (win[1] + lose[1]) * 0.5];
                (win, lose, chop)
            }
            // Tournament equity. Three DP evaluations per terminal, one per outcome.
            Some(icm) => {
                // What each in-hand seat still has at the table with the pot not yet
                // awarded: their stack at the root of the node, less what they put in
                // here. The uncalled part of a bet is already back in `node.stacks`.
                let kept = [
                    icm.stacks[icm.seats[0]] - cfg.effective_stack + node.stacks[0],
                    icm.stacks[icm.seats[1]] - cfg.effective_stack + node.stacks[1],
                ];
                let p0 = icm.payoff([kept[0] + net, kept[1]]);
                let p1 = icm.payoff([kept[0], kept[1] + net]);
                let split = icm.payoff([kept[0] + net * 0.5, kept[1] + net * 0.5]);
                // `win[p]` is p's payoff when p is awarded the pot, `lose[p]` when the
                // opponent is. Those are two readings of the same two vectors — which
                // is exactly why they no longer sum to zero.
                ([p0[0], p1[1]], [p1[0], p0[1]], split)
            }
        };
        TermData {
            board,
            folder: match t {
                TreeTerminal::Fold { folder, .. } => Some(*folder),
                TreeTerminal::Showdown { .. } => None,
            },
            win,
            lose,
            chop,
        }
    }

    // -- accessors -----------------------------------------------------------------

    /// The config this game was built from.
    pub fn config(&self) -> &SolveConfig {
        &self.cfg
    }

    /// The public betting tree.
    pub fn tree(&self) -> &GameTree {
        &self.tree
    }

    /// Pot, stacks and street at a node.
    pub fn node_at(&self, node: u32) -> &Node {
        self.tree.node(node)
    }

    /// The board *known at* `node`, including every chance card dealt on the path.
    ///
    /// A chance node reports the board before its own deal, because that is the board
    /// its combo vectors live on.
    pub fn board_at(&self, node: u32) -> &[Card] {
        &self.boards[self.node_board[node as usize] as usize].board
    }

    /// Live hole-card combos for `player` at `node`, canonical ascending order.
    pub fn live_combos(&self, node: u32, player: u8) -> &[Hand] {
        &self.boards[self.node_board[node as usize] as usize].hands[player as usize]
    }

    /// The canonical 1326-combo index of each entry of [`NlheGame::live_combos`].
    pub fn combo_indices(&self, node: u32, player: u8) -> &[u32] {
        &self.boards[self.node_board[node as usize] as usize].indices[player as usize]
    }

    /// The node each `[[locks]]` entry of the config resolved to, in config order.
    pub fn locked_nodes(&self) -> Vec<u32> {
        self.locks.iter().map(|&(node, _)| node).collect()
    }

    /// Number of distinct boards the tree reaches (`1 + 49 + 49*48` for a flop).
    pub fn num_boards(&self) -> usize {
        self.boards.len()
    }

    /// Bytes held by the shared chance maps. The naive per-chance-node alternative costs
    /// this times the number of chance nodes sharing each board.
    pub fn chance_map_bytes(&self) -> usize {
        self.maps
            .values()
            .flat_map(|v| v.iter())
            .map(|m| (m.0[0].len() + m.0[1].len()) * std::mem::size_of::<u32>())
            .sum()
    }

    /// Opponent reach mass compatible with each of `hero`'s live combos at `node`.
    ///
    /// This is the per-combo denominator that turns a counterfactual value into an EV
    /// in chips: pairs sharing a card are impossible and excluded exactly.
    pub fn compatible_mass(&self, node: u32, hero: u8, opp_reach: &[f32]) -> Vec<f32> {
        let b = &self.boards[self.node_board[node as usize] as usize];
        let (h, o) = (hero as usize, 1 - hero as usize);
        let mut out = vec![0.0f32; b.hands[h].len()];
        terminal::fold_ev(&b.hands[h], &b.hands[o], opp_reach, 1.0, &mut out);
        out
    }

    /// Per-combo EV in chips for `hero` at the root under `profile`, one entry per root
    /// combo slot in [`NlheGame::live_combos`] order.
    ///
    /// Zero-sum convention (see the module docs); pass through
    /// [`NlheGame::ev_pot_share`] for the pot-inclusive display figure. A combo whose
    /// opponent-compatible mass is zero reports `0.0`.
    pub fn root_combo_evs<P: StrategyProfile>(&self, hero: u8, profile: &P) -> Vec<f32> {
        let root = self.root();
        let hn = self.combo_count(root, hero);
        let mut cfv = vec![0.0f32; hn];
        br::subtree_values(
            self,
            root,
            hero,
            profile,
            self.root_weights(1 - hero),
            false,
            &mut cfv,
        );
        let mass = self.compatible_mass(root, hero, self.root_weights(1 - hero));
        // Chance mass needs no correction: the conditional deal weights give every pair
        // exactly one unit of runout mass, so the compatible opponent mass is the whole
        // denominator.
        for (v, m) in cfv.iter_mut().zip(&mass) {
            *v = if *m > 0.0 { *v / *m } else { 0.0 };
        }
        cfv
    }

    /// Converts a zero-sum EV (net chips vs the start of the solve) into the
    /// PioSOLVER-style pot-inclusive figure by handing back the `starting_pot/2` credit
    /// the zero-sum convention took away.
    ///
    /// The two players' pot-share EVs sum to `starting_pot` (less rake), which is what a
    /// solver UI shows beside a range.
    ///
    /// Under a tournament payoff map the credit handed back is the seat's own root
    /// equity in CSTE chips instead, so the figure reads as "what this seat is worth
    /// right now" — the same question, the same slot, in the unit the solve is scored
    /// in. The two seats' figures then sum to the pair's absolute equity, not to
    /// `starting_pot`; nothing in the file format changes.
    pub fn ev_pot_share(&self, hero: u8, ev_zero_sum: f32) -> f32 {
        debug_assert!(hero < 2, "player must be 0 or 1");
        match &self.icm {
            None => ev_zero_sum + (self.cfg.starting_pot * 0.5) as f32,
            Some(icm) => ev_zero_sum + (icm.root[icm.seats[hero as usize]] * icm.scale) as f32,
        }
    }
}

impl Game for NlheGame {
    fn root(&self) -> u32 {
        self.tree.root()
    }

    fn num_nodes(&self) -> usize {
        self.info.len()
    }

    fn node(&self, node: u32) -> NodeInfo {
        self.info[node as usize]
    }

    fn child(&self, node: u32, action: usize) -> u32 {
        match &self.tree.node(node).kind {
            NodeKind::Decision { actions, .. } => actions[action].child,
            other => panic!("child() on a non-decision node {node}: {other:?}"),
        }
    }

    fn combo_count(&self, node: u32, player: u8) -> usize {
        self.boards[self.node_board[node as usize] as usize].hands[player as usize].len()
    }

    fn root_weights(&self, player: u8) -> &[f32] {
        &self.root_weights[player as usize]
    }

    fn chance_outcome(&self, node: u32, outcome: usize) -> ChanceEdge<'_> {
        let c = &self.chance[self.node_aux[node as usize] as usize];
        let (card, child) = c.outcomes[outcome];
        let m = &self.maps[&c.board][card as usize];
        ChanceEdge {
            child,
            weight: c.weight,
            parent_of_child: [&m.0[0], &m.0[1]],
        }
    }

    fn terminal_utility(&self, node: u32, hero: u8, opp_reach: &[f32], out: &mut [f32]) {
        let t = &self.terms[self.node_aux[node as usize] as usize];
        let b = &self.boards[t.board as usize];
        let (h, o) = (hero as usize, 1 - hero as usize);
        match t.folder {
            Some(f) => {
                // The folder is awarded nothing; the other player takes the pot.
                let payoff = if f == hero { t.lose[h] } else { t.win[h] };
                terminal::fold_ev(&b.hands[h], &b.hands[o], opp_reach, payoff, out);
            }
            None => terminal::showdown_ev_ranked(
                &b.hands[h],
                b.ranks[h].as_ref().expect("showdown on a 5-card board"),
                &b.hands[o],
                b.ranks[o].as_ref().expect("showdown on a 5-card board"),
                opp_reach,
                t.win[h],
                t.lose[h],
                t.chop[h],
                out,
            ),
        }
    }

    fn normalizer(&self) -> f32 {
        self.normalizer
    }

    fn root_pot(&self) -> f32 {
        self.cfg.starting_pot as f32
    }

    fn zero_sum(&self) -> bool {
        // An ICM spot is general-sum: the frozen field absorbs equity whenever chips
        // move, and by a different amount at every terminal. See the module docs.
        self.icm.is_none()
    }

    fn locked_strategy(&self, node: u32) -> Option<&[f32]> {
        // `lock_at` is empty unless the config locks something, so an unlocked solve
        // pays one bounds check per decision-node visit and nothing else.
        match *self.lock_at.get(node as usize)? {
            NONE => None,
            i => Some(&self.locks[i as usize].1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cfr::{DcfrParams, Solver};
    use crate::config::Sizings;
    use crate::tree::{ActionLabel, NodeCounts};
    use std::time::Instant;

    // =====================================================================
    // MILESTONE 3 — polarized vs condensed river, verified by hand
    // =====================================================================
    //
    // Board Ks 7d 2c 8h 3d. Pot 10, effective stack 10, one sizing: 100% pot
    // (= the whole stack, so it is labelled AllIn) and no raises.
    //
    //   OOP value  KK   = {KcKd, KcKh, KdKh}          3 combos (Ks is on the board)
    //   OOP air    A4s  = {Ac4c, Ad4d, Ah4h, As4s}    4 combos
    //              A5s  = {Ac5c, Ad5d, Ah5h, As5s}    4 combos
    //   IP         TT   = 6 combos, JJ = 6 combos    12 combos
    //
    // BLOCKERS: OOP's range uses only kings, aces, fours and fives; IP's uses only
    // tens and jacks. The two card sets are DISJOINT, so every one of the 11 x 12
    // combo pairs is possible and card removal moves nothing at all. This is the
    // idealized game exactly, not an approximation of it — the tolerances below are
    // therefore about solver convergence, not blocker noise.
    //
    // HAND RANKINGS on Ks 7d 2c 8h 3d: KK = three kings (beats everything else);
    // TT/JJ = one pair (beats every OOP air hand); A4/A5 = ace high and can make no
    // straight (needs a 5 resp. a 4, neither on board) and no flush (only two
    // diamonds on board), so air NEVER wins a showdown.
    //
    // STAKES (module docs): S = 10, E = 10, so stake = 5 + contribution.
    //   check/check showdown  P = 10, stake 5  -> win +5,  lose -5
    //   bet, fold             P = 10, stake 5  -> +5 to the bettor, -5 to the folder
    //   bet, call showdown    P = 30, stake 15 -> win +15, lose -15
    //
    // EQUILIBRIUM, by hand:
    //   IP is indifferent facing the pot bet when   b * (+15) = v * (15)  with weights
    //   b/(v+b), v/(v+b)  ->  b/v = 1/2: the betting range is 2/3 value, 1/3 bluff.
    //   OOP air is indifferent when   f*(+5) + (1-f)*(-15) = -5  ->  f = 1/2:
    //   IP defends exactly MDF = 1/2 of its bluffcatchers.
    //   v = 3 KK combos betting pure (check-check would net only +5 vs 10 for betting),
    //   so b = 1.5 combos out of 8 air combos -> air bets 1.5/8 = 0.1875.
    //   Root EV(OOP) = (3 * 10 + 8 * (-5)) / 11 = -10/11 = -0.90909.
    //   Cross-check from IP's side: IP faces a bet 4.5/11 of the time and is
    //   indifferent there (-5), and wins the pot the other 6.5/11 (+5):
    //   (4.5*(-5) + 6.5*(+5))/11 = +10/11.  Zero-sum. ✔
    //
    // The check branch is degenerate on purpose: OOP's checking range is pure air
    // that loses every showdown, so IP betting it out and IP checking it back are
    // worth exactly the same (+5), and OOP folding to a bet is worth exactly what
    // losing the showdown is worth (-5). Nothing there perturbs the numbers above.

    const M3_BOARD: &str = "Ks 7d 2c 8h 3d";
    const M3_OOP: &str = "KK,A4s,A5s";
    const M3_IP: &str = "TT,JJ";

    fn milestone3_cfg() -> SolveConfig {
        let mut cfg = SolveConfig {
            board: M3_BOARD.to_string(),
            oop_range: M3_OOP.to_string(),
            ip_range: M3_IP.to_string(),
            effective_stack: 10.0,
            starting_pot: 10.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        cfg.sizings.oop.river.bet = Sizings::new(&[100.0], false);
        cfg.sizings.ip.river.bet = Sizings::new(&[100.0], false);
        cfg
    }

    fn solve(cfg: &SolveConfig, iters: u64, report_every: u64) -> (Solver<NlheGame>, Vec<(u64, f32, f32)>) {
        let game = NlheGame::new(cfg).expect("game builds");
        let mut s = Solver::new(game);
        let mut log = Vec::new();
        s.run(iters, &DcfrParams::default(), report_every, |i, c, p| {
            log.push((i, c, p))
        });
        (s, log)
    }

    /// Slot of a named combo in a player's live list at a node.
    fn slot(g: &NlheGame, node: u32, player: u8, combo: &str) -> usize {
        let c = cards::parse_cards(combo).expect("combo parses");
        assert_eq!(c.len(), 2);
        let want = crate::range::combo_index(c[0], c[1]) as u32;
        g.combo_indices(node, player)
            .iter()
            .position(|&i| i == want)
            .unwrap_or_else(|| panic!("{combo} is not live for player {player} at node {node}"))
    }

    fn action(g: &NlheGame, node: u32, want: ActionLabel) -> u32 {
        match &g.tree().node(node).kind {
            NodeKind::Decision { actions, .. } => actions
                .iter()
                .find(|a| a.label == want)
                .unwrap_or_else(|| {
                    panic!(
                        "no {want:?} at node {node}; have {:?}",
                        actions.iter().map(|a| a.label).collect::<Vec<_>>()
                    )
                })
                .child,
            other => panic!("node {node} is not a decision: {other:?}"),
        }
    }

    /// Mean of `strategy[action]` over the combos named by `slots`, weight 1 each.
    fn freq(strategy: &[f32], n_combo: usize, action: usize, slots: &[usize]) -> f32 {
        slots
            .iter()
            .map(|&i| strategy[action * n_combo + i])
            .sum::<f32>()
            / slots.len() as f32
    }

    fn slots_for(g: &NlheGame, player: u8, tokens: &[&str]) -> Vec<usize> {
        tokens.iter().map(|t| slot(g, 0, player, t)).collect()
    }

    const KK: [&str; 3] = ["KcKd", "KcKh", "KdKh"];
    const AIR: [&str; 8] = [
        "Ac4c", "Ad4d", "Ah4h", "As4s", "Ac5c", "Ad5d", "Ah5h", "As5s",
    ];
    const BLUFFCATCH: [&str; 12] = [
        "TcTd", "TcTh", "TcTs", "TdTh", "TdTs", "ThTs", "JcJd", "JcJh", "JcJs", "JdJh", "JdJs",
        "JhJs",
    ];

    #[test]
    fn milestone3_tree_and_ranges_are_the_spot_we_designed() {
        let g = NlheGame::new(&milestone3_cfg()).expect("builds");
        assert_eq!(g.combo_count(0, 0), 11, "OOP: 3 KK + 8 air");
        assert_eq!(g.combo_count(0, 1), 12, "IP: TT + JJ");
        assert_eq!(g.num_boards(), 1, "a river tree deals no cards");
        assert_eq!(g.chance_map_bytes(), 0, "a river tree has no chance maps");
        assert_eq!(
            g.tree().counts(),
            NodeCounts { decision: 4, chance: 0, fold: 2, showdown: 3, total: 9 }
        );
        assert_eq!(g.board_at(0).len(), 5);
        assert_eq!(cards::cards_to_string(g.board_at(0)), M3_BOARD);

        // Card removal really is inert here: every OOP combo sees the full IP range.
        let mass = g.compatible_mass(0, 0, g.root_weights(1));
        assert!(mass.iter().all(|&m| (m - 12.0).abs() < 1e-6), "{mass:?}");

        // The single sizing is a pot-size bet, which is the whole 10-chip stack.
        let bet = action(&g, 0, ActionLabel::AllIn);
        assert!((g.node_at(bet).pot - 20.0).abs() < 1e-9);
        assert_eq!(g.node_at(bet).stacks[0], 0.0);
    }

    #[test]
    fn milestone3_converges_monotonically_below_half_a_basis_point() {
        let cfg = milestone3_cfg();
        let t0 = Instant::now();
        let (s, log) = solve(&cfg, 20_000, 100);
        let wall = t0.elapsed();
        for (i, chips, pct) in &log {
            println!("m3 iter {i:>6}  exploitability {chips:.9} chips  {pct:.6}% of pot");
        }
        println!(
            "m3 MEASURED wall time: {:?} for 20000 iters + {} exploitability reports",
            wall,
            log.len()
        );

        let final_pct = log.last().unwrap().2;
        assert!(final_pct < 0.05, "exploitability {final_pct}% of pot is not < 0.05%");

        // MONOTONICITY. Report-to-report, DCFR exploitability is *not* monotone and
        // asserting that it is would be asserting something false: the discount schedule
        // reshuffles regret between actions every iteration, so a 100-iteration window
        // routinely bounces (e.g. 0.00174 at 500 -> 0.00269 at 600 in this very spot).
        // What is monotone is the decade envelope, which is exactly the check milestone 1
        // makes on Kuhn — plus two stronger claims that a lucky single sample could not
        // satisfy.
        let at = |iter: u64| log.iter().find(|r| r.0 == iter).expect("report exists").1;
        let decades = [at(100), at(1_000), at(10_000), at(20_000)];
        println!("m3 decade envelope: {decades:?}");
        for w in decades.windows(2) {
            assert!(w[1] <= w[0] + 1e-6, "decade envelope rose: {} -> {}", w[0], w[1]);
        }

        // The descent is real, not one lucky sample: the median report of the last
        // quarter is several times below the median of the first quarter (measured 6x;
        // asserted at 4x).
        // (Medians, not min/max — the bounce means a single early report can dip below a
        // single late one without the curve having failed to descend.)
        let median = |xs: &[(u64, f32, f32)]| {
            let mut v: Vec<f32> = xs.iter().map(|r| r.1).collect();
            v.sort_by(f32::total_cmp);
            v[v.len() / 2]
        };
        let q = log.len() / 4;
        let (early, late) = (median(&log[..q]), median(&log[3 * q..]));
        println!("m3 median exploitability: first quarter {early:.9}, last quarter {late:.9}");
        assert!(late * 4.0 < early, "median {late} is not 4x below {early}");

        // And the 0.05%-of-pot gate holds for *every* report from iteration 1000 on,
        // not merely for the last one.
        for &(i, _, pct) in log.iter().filter(|r| r.0 >= 1_000) {
            assert!(pct < 0.05, "iter {i} exploitability {pct}% of pot is not < 0.05%");
        }
        assert!(s.exploitability().chips >= 0.0);
    }

    #[test]
    fn milestone3_frequencies_match_theory() {
        let (s, _) = solve(&milestone3_cfg(), 20_000, 0);
        let g = s.game();
        let oop = s.average_strategy(0);
        let n0 = g.combo_count(0, 0);
        let (check, bet) = (0usize, 1usize);

        let kk = slots_for(g, 0, &KK);
        let air = slots_for(g, 0, &AIR);
        let kk_bet = freq(&oop, n0, bet, &kk);
        let air_bet = freq(&oop, n0, bet, &air);
        println!("m3 OOP: KK bet {kk_bet:.4}  air bet {air_bet:.4}  (air check {:.4})", freq(&oop, n0, check, &air));

        // Value bets pure: betting is worth 10 chips, checking only 5.
        assert!(kk_bet > 0.97, "KK should bet ~always, got {kk_bet}");
        // Bluff:value = 1:2, i.e. bluffs are 1/3 of the betting range.
        let value_mass = 3.0 * kk_bet;
        let bluff_mass = 8.0 * air_bet;
        let bluff_share = bluff_mass / (value_mass + bluff_mass);
        println!("m3 betting range: value {value_mass:.4} bluff {bluff_mass:.4} -> bluff share {bluff_share:.4}");
        assert!(
            (bluff_share - 1.0 / 3.0).abs() < 0.03,
            "bluff share {bluff_share} != 1/3"
        );
        assert!((air_bet - 0.1875).abs() < 0.03, "air bet freq {air_bet} != 1.5/8");

        // IP defends MDF = 1/2 of its bluffcatchers against a pot-size bet.
        let facing = action(g, 0, ActionLabel::AllIn);
        let ip = s.average_strategy(facing);
        let n1 = g.combo_count(facing, 1);
        let bc = BLUFFCATCH.iter().map(|t| slot(g, facing, 1, t)).collect::<Vec<_>>();
        let call = freq(&ip, n1, 1, &bc); // actions are [Fold, Call]
        println!("m3 IP call frequency facing the pot bet: {call:.4}");
        assert!((call - 0.5).abs() < 0.03, "IP call frequency {call} != MDF 1/2");
    }

    #[test]
    fn milestone3_indifference_conditions_hold_for_named_combos() {
        let (s, _) = solve(&milestone3_cfg(), 20_000, 0);
        let g = s.game();
        let avg = s.average();

        // ---- OOP air: EV(bet) vs EV(check) --------------------------------------
        // Idealized: EV(check) = -5 (air never wins, and folding to IP's bet after a
        // check is worth the same -5). EV(bet) = f*(+5) + (1-f)*(-15) = -5 at f = 1/2.
        let bet_child = action(g, 0, ActionLabel::AllIn);
        let check_child = action(g, 0, ActionLabel::Check);
        let ip_reach = g.root_weights(1);
        let hn = g.combo_count(0, 0);
        let mut ev_bet = vec![0.0f32; hn];
        let mut ev_check = vec![0.0f32; hn];
        br::subtree_values(g, bet_child, 0, &avg, ip_reach, false, &mut ev_bet);
        br::subtree_values(g, check_child, 0, &avg, ip_reach, false, &mut ev_check);
        let mass = g.compatible_mass(0, 0, ip_reach);
        for (v, m) in ev_bet.iter_mut().zip(&mass) {
            *v /= m;
        }
        for (v, m) in ev_check.iter_mut().zip(&mass) {
            *v /= m;
        }

        let air = slot(g, 0, 0, "Ac4c");
        println!(
            "m3 indifference OOP Ac4c: EV(bet) {:.5}  EV(check) {:.5}  (theory -5.00000 both)",
            ev_bet[air], ev_check[air]
        );
        let strat = s.average_strategy(0);
        let air_bet_freq = strat[hn + air];
        assert!(
            (0.02..0.98).contains(&air_bet_freq),
            "Ac4c must actually mix to be indifferent, bets {air_bet_freq}"
        );
        assert!(
            (ev_bet[air] - ev_check[air]).abs() < 0.05,
            "Ac4c EV(bet) {} != EV(check) {}",
            ev_bet[air],
            ev_check[air]
        );
        assert!(
            (ev_check[air] + 5.0).abs() < 0.05,
            "Ac4c check EV {} != the hand-computed -5",
            ev_check[air]
        );

        // Value is not indifferent: betting KK is worth 10, checking only 5.
        let kk = slot(g, 0, 0, "KcKd");
        println!(
            "m3 OOP KcKd: EV(bet) {:.5}  EV(check) {:.5}  (theory +10 / +5)",
            ev_bet[kk], ev_check[kk]
        );
        assert!(ev_bet[kk] > ev_check[kk] + 3.0, "KK must strictly prefer betting");
        assert!((ev_bet[kk] - 10.0).abs() < 0.15, "KK bet EV {} != 10", ev_bet[kk]);

        // ---- IP bluffcatcher: EV(call) vs EV(fold) ------------------------------
        // Idealized: EV(fold) = -5 (stake forfeited). EV(call) = (1/3)*(+15) +
        // (2/3)*(-15) = -5 once OOP's betting range is 1/3 bluffs.
        let mut oop_reach = g.root_weights(0).to_vec();
        for (i, w) in oop_reach.iter_mut().enumerate() {
            *w *= strat[hn + i]; // OOP's bet probability for combo i
        }
        let fold_child = action(g, bet_child, ActionLabel::Fold);
        let call_child = action(g, bet_child, ActionLabel::Call);
        let ipn = g.combo_count(bet_child, 1);
        let mut ev_fold = vec![0.0f32; ipn];
        let mut ev_call = vec![0.0f32; ipn];
        br::subtree_values(g, fold_child, 1, &avg, &oop_reach, false, &mut ev_fold);
        br::subtree_values(g, call_child, 1, &avg, &oop_reach, false, &mut ev_call);
        let ip_mass = g.compatible_mass(bet_child, 1, &oop_reach);
        for (v, m) in ev_fold.iter_mut().zip(&ip_mass) {
            *v /= m;
        }
        for (v, m) in ev_call.iter_mut().zip(&ip_mass) {
            *v /= m;
        }

        let bc = slot(g, bet_child, 1, "TcTd");
        let ip_strat = s.average_strategy(bet_child);
        let call_freq = ip_strat[ipn + bc];
        println!(
            "m3 indifference IP TcTd facing the bet: EV(call) {:.5}  EV(fold) {:.5}  \
             (theory -5.00000 both), mixes call at {call_freq:.4}",
            ev_call[bc], ev_fold[bc]
        );
        assert!(
            (0.02..0.98).contains(&call_freq),
            "TcTd must actually mix to be indifferent, calls {call_freq}"
        );
        assert!(
            (ev_call[bc] - ev_fold[bc]).abs() < 0.05,
            "TcTd EV(call) {} != EV(fold) {}",
            ev_call[bc],
            ev_fold[bc]
        );
        assert!(
            (ev_fold[bc] + 5.0).abs() < 1e-4,
            "folding always forfeits exactly the 5-chip stake, got {}",
            ev_fold[bc]
        );
    }

    #[test]
    fn milestone3_values_are_zero_sum_and_match_the_hand_computation() {
        let (s, _) = solve(&milestone3_cfg(), 20_000, 0);
        let g = s.game();
        let v0 = s.expected_value(0);
        let v1 = s.expected_value(1);
        println!("m3 EV: OOP {v0:.6}  IP {v1:.6}  sum {:.9}  (theory -10/11, +10/11)", v0 + v1);
        assert!((v0 + v1).abs() < 1e-3, "values {v0} + {v1} are not zero-sum");
        assert!(
            (v0 - (-10.0 / 11.0)).abs() < 0.03,
            "OOP value {v0} != the hand-computed -10/11"
        );

        // Pot-share display convention: the two sides sum to the starting pot.
        let (p0, p1) = (g.ev_pot_share(0, v0), g.ev_pot_share(1, v1));
        println!("m3 pot-share EV: OOP {p0:.6}  IP {p1:.6}  sum {:.6}", p0 + p1);
        assert!((p0 + p1 - 10.0).abs() < 1e-3);

        // Per-combo root EVs line up with the aggregate and with the hand numbers.
        let evs = g.root_combo_evs(0, &s.average());
        let kk = slot(g, 0, 0, "KcKd");
        let air = slot(g, 0, 0, "Ac4c");
        println!("m3 per-combo root EV: KcKd {:.5} (theory +10)  Ac4c {:.5} (theory -5)", evs[kk], evs[air]);
        assert!((evs[kk] - 10.0).abs() < 0.15);
        assert!((evs[air] + 5.0).abs() < 0.05);
        let mean: f32 = evs.iter().sum::<f32>() / evs.len() as f32;
        assert!((mean - v0).abs() < 1e-3, "per-combo mean {mean} != root EV {v0}");
    }

    #[test]
    fn milestone3_is_bit_identical_across_identical_solves() {
        let cfg = milestone3_cfg();
        let (a, _) = solve(&cfg, 2_000, 0);
        let (b, _) = solve(&cfg, 2_000, 0);
        assert_eq!(a.exploitability(), b.exploitability());
        for node in [0u32, 1, 2] {
            if matches!(a.game().node(node), NodeInfo::Decision { .. }) {
                assert_eq!(a.average_strategy(node), b.average_strategy(node), "node {node}");
            }
        }
    }

    // =====================================================================
    // Realistic river convergence smoke test
    // =====================================================================

    #[test]
    fn realistic_river_spot_converges() {
        // ~22% OOP vs ~12% IP on a fixed (arbitrary) river board — fixed rather than
        // randomly drawn so the run is reproducible.
        let mut cfg = SolveConfig {
            board: "Qh 9s 4d Jc 2h".to_string(),
            oop_range: "22+,A2s+,K7s+,Q9s+,JTs,T9s,98s,A9o+,KTo+,QJo".to_string(),
            ip_range: "55+,A9s+,KTs+,QTs+,JTs,AJo+,KQo".to_string(),
            effective_stack: 100.0,
            starting_pot: 20.0,
            raise_cap: 1,
            ..SolveConfig::default()
        };
        cfg.sizings.oop.river.bet = Sizings::new(&[75.0], false);
        cfg.sizings.ip.river.bet = Sizings::new(&[75.0], false);
        cfg.sizings.oop.river.raise = Sizings::new(&[100.0], false);
        cfg.sizings.ip.river.raise = Sizings::new(&[100.0], false);

        let t0 = Instant::now();
        let g = NlheGame::new(&cfg).expect("builds");
        let build = t0.elapsed();

        // The raise sizing really is in the tree, so this is not a bet-only smoke test.
        let facing = action(&g, action(&g, 0, ActionLabel::Check), ActionLabel::Bet(15.0));
        let raises: Vec<ActionLabel> = match &g.tree().node(facing).kind {
            NodeKind::Decision { actions, .. } => actions
                .iter()
                .map(|a| a.label)
                .filter(|l| matches!(l, ActionLabel::Raise(_) | ActionLabel::AllIn))
                .collect(),
            _ => unreachable!(),
        };
        assert_eq!(raises.len(), 1, "expected exactly one raise sizing, got {raises:?}");
        println!("realistic river raise action: {:?}", raises[0]);

        println!(
            "realistic river: {} nodes, OOP {} combos, IP {} combos, build {:?}",
            g.num_nodes(),
            g.combo_count(0, 0),
            g.combo_count(0, 1),
            build
        );

        let t1 = Instant::now();
        let mut s = Solver::new(g);
        let mut log = Vec::new();
        s.run(2_000, &DcfrParams::default(), 250, |i, c, p| log.push((i, c, p)));
        let wall = t1.elapsed();
        for (i, chips, pct) in &log {
            println!("river iter {i:>5}  exploitability {chips:.9} chips  {pct:.6}% of pot");
        }
        println!("realistic river MEASURED wall time: {wall:?} for 2000 iters (+8 BR reports)");

        let final_pct = log.last().unwrap().2;
        assert!(final_pct < 0.5, "exploitability {final_pct}% of pot is not < 0.5%");
        // Monotone-ish: never worse than the previous report by more than 1% relative.
        for w in log[1..].windows(2) {
            assert!(
                w[1].1 <= w[0].1 * 1.01 + 1e-6,
                "exploitability jumped from {} at {} to {} at {}",
                w[0].1,
                w[0].0,
                w[1].1,
                w[1].0
            );
        }
        let (v0, v1) = (s.expected_value(0), s.expected_value(1));
        println!("realistic river EV: OOP {v0:.6} IP {v1:.6} sum {:.9}", v0 + v1);
        assert!((v0 + v1).abs() < 1e-2, "not zero-sum: {v0} + {v1}");
    }

    // =====================================================================
    // Chance-edge sharing, memory, and the normalizer
    // =====================================================================

    fn flop_checkdown_cfg(oop: &str, ip: &str) -> SolveConfig {
        // No sizing tables at all: a legal check-down tree over the full runout, which
        // is the cheapest way to exercise every chance node and river board.
        SolveConfig {
            board: "As Kd 7h".to_string(),
            oop_range: oop.to_string(),
            ip_range: ip.to_string(),
            effective_stack: 100.0,
            starting_pot: 10.0,
            ..SolveConfig::default()
        }
    }

    #[test]
    fn flop_tree_shares_chance_maps_across_betting_lines() {
        let cfg = flop_checkdown_cfg("random", "random");
        let t0 = Instant::now();
        let g = NlheGame::new(&cfg).expect("builds");
        let build = t0.elapsed();

        assert_eq!(g.combo_count(0, 0), 1176, "flop root combos");
        // Boards are keyed by mask, so Ts-then-2h and 2h-then-Ts are one river board:
        // 1 flop + 49 turns + C(49,2) rivers, not 49*48 rivers.
        assert_eq!(g.num_boards(), 1 + 49 + 49 * 48 / 2, "flop + 49 turns + C(49,2) rivers");

        // 49 turn maps + 49*48 river maps, per player. Counted from the stored groups:
        // one group per board that is dealt from (the flop, and each of the 49 turns).
        assert_eq!(g.maps.len(), 1 + 49, "one map group per board dealt from");
        let map_entries: usize = g
            .maps
            .values()
            .flat_map(|v| v.iter())
            .filter(|m| !m.0[0].is_empty() || !m.0[1].is_empty())
            .count();
        assert_eq!(map_entries, 49 + 49 * 48, "one map per (board, dealt card)");

        // Every chance node with the same parent board hands out the *same* slices.
        let chance_nodes: Vec<u32> = (0..g.num_nodes() as u32)
            .filter(|&i| matches!(g.node(i), NodeInfo::Chance { .. }))
            .collect();
        assert_eq!(chance_nodes.len(), 1 + 49);
        for &c in &chance_nodes {
            let NodeInfo::Chance { num_outcomes } = g.node(c) else { unreachable!() };
            for k in 0..num_outcomes {
                let e = g.chance_outcome(c, k);
                for p in 0..2 {
                    let m = e.parent_of_child[p];
                    assert_eq!(m.len(), g.combo_count(e.child, p as u8));
                    assert!(m.windows(2).all(|w| w[0] < w[1]), "map must be ascending");
                    assert!(m.iter().all(|&i| (i as usize) < g.combo_count(c, p as u8)));
                    // The map really does select the child's hands out of the parent's.
                    let parent = g.live_combos(c, p as u8);
                    let child = g.live_combos(e.child, p as u8);
                    assert!(m.iter().zip(child).all(|(&i, &h)| parent[i as usize] == h));
                }
                // Conditional weight: four of the outcomes are dead for any given pair.
                assert!((e.weight - 1.0 / (num_outcomes - 4) as f32).abs() < 1e-7);
            }
        }

        let shared = g.chance_map_bytes();
        // What a per-chance-node copy would have cost on this (tiny, check-down) tree.
        let naive: usize = chance_nodes
            .iter()
            .map(|&c| {
                let NodeInfo::Chance { num_outcomes } = g.node(c) else { unreachable!() };
                (0..num_outcomes)
                    .map(|k| {
                        let e = g.chance_outcome(c, k);
                        (e.parent_of_child[0].len() + e.parent_of_child[1].len()) * 4
                    })
                    .sum::<usize>()
            })
            .sum();
        println!(
            "flop chance maps MEASURED: {} groups, {map_entries} maps, {} bytes shared \
             ({:.2} MB); the same tree copied per chance node = {} bytes ({:.2} MB); \
             build {:?}",
            g.maps.len(),
            shared,
            shared as f64 / 1.048576e6,
            naive,
            naive as f64 / 1.048576e6,
            build
        );
        assert!(shared > 0);
        // On a check-down tree there is exactly one chance node per board, so sharing
        // breaks even here; every extra betting line multiplies the naive figure and
        // leaves the shared one untouched.
        assert_eq!(shared, naive);
    }

    /// The chance-map tables are per *board*, so adding betting lines (which multiplies
    /// the number of chance nodes) must not grow them at all.
    #[test]
    fn chance_map_memory_is_independent_of_the_betting_tree() {
        let mut small = flop_checkdown_cfg("TT+,AQs+", "99+,AJs+");
        let plain = NlheGame::new(&small).expect("builds");
        let plain_nodes = plain.tree().counts().chance;
        let plain_bytes = plain.chance_map_bytes();

        small.sizings.oop.flop.bet = Sizings::new(&[50.0], false);
        small.sizings.ip.flop.bet = Sizings::new(&[50.0], false);
        small.raise_cap = 0;
        let bigger = NlheGame::new(&small).expect("builds");

        println!(
            "chance nodes {} -> {}, map bytes {} -> {} (unchanged)",
            plain_nodes,
            bigger.tree().counts().chance,
            plain_bytes,
            bigger.chance_map_bytes()
        );
        assert!(bigger.tree().counts().chance > plain_nodes * 2);
        assert_eq!(bigger.chance_map_bytes(), plain_bytes);
        assert_eq!(bigger.num_boards(), plain.num_boards());
    }

    /// `normalizer()` must be the total joint reach mass the traversal actually
    /// accumulates: over every runout, over every compatible pair live on it, weighted
    /// by the chance weights. Checked here against a direct enumeration.
    ///
    /// The weights are conditional (`1/(unseen - 4)` per deal, corrected 2026-09-01), so
    /// a pair contributes its full `w0 * w1` on every board length and the enumeration
    /// collapses back onto the plain joint mass — which is exactly the claim the closed
    /// form makes.
    fn assert_normalizer_matches_enumeration(cfg: &SolveConfig) {
        let g = NlheGame::new(cfg).expect("builds");
        let board = cfg.board_cards().unwrap();
        let base = cards::mask_of(&board);
        let hands: [Vec<Hand>; 2] = [g.live_combos(0, 0).to_vec(), g.live_combos(0, 1).to_vec()];
        let w: [Vec<f32>; 2] = [g.root_weights(0).to_vec(), g.root_weights(1).to_vec()];

        // Joint mass over compatible pairs on one runout mask.
        let mass_on = |extra: u64| -> f64 {
            let live: Vec<Vec<usize>> = (0..2)
                .map(|p| {
                    (0..hands[p].len())
                        .filter(|&k| hand_mask(hands[p][k]) & extra == 0)
                        .collect()
                })
                .collect();
            let h0: Vec<Hand> = live[0].iter().map(|&k| hands[0][k]).collect();
            let h1: Vec<Hand> = live[1].iter().map(|&k| hands[1][k]).collect();
            let r1: Vec<f32> = live[1].iter().map(|&k| w[1][k]).collect();
            let mut compat = vec![0.0f32; h0.len()];
            terminal::fold_ev(&h0, &h1, &r1, 1.0, &mut compat);
            live[0]
                .iter()
                .zip(&compat)
                .map(|(&k, &m)| w[0][k] as f64 * m as f64)
                .sum()
        };

        let deck: Vec<Card> = (0..NUM_CARDS as Card)
            .filter(|&c| base & cards::card_mask(c) == 0)
            .collect();
        let brute: f64 = match board.len() {
            5 => mass_on(0),
            4 => {
                let p = 1.0 / (deck.len() - 4) as f64;
                deck.iter().map(|&r| p * mass_on(cards::card_mask(r))).sum()
            }
            3 => {
                let pt = 1.0 / (deck.len() - 4) as f64;
                let pr = 1.0 / (deck.len() - 1 - 4) as f64;
                deck.iter()
                    .map(|&t| {
                        let tm = cards::card_mask(t);
                        pt * pr
                            * deck
                                .iter()
                                .filter(|&&r| r != t)
                                .map(|&r| mass_on(tm | cards::card_mask(r)))
                                .sum::<f64>()
                    })
                    .sum()
            }
            n => panic!("bad board length {n}"),
        };
        let got = g.normalizer() as f64;
        println!(
            "normalizer on a {}-card board: closed form {got:.6}, enumerated {brute:.6}, \
             rel err {:.3e}",
            board.len(),
            (got - brute).abs() / brute
        );
        assert!(
            (got - brute).abs() / brute < 1e-5,
            "normalizer {got} != enumerated {brute}"
        );
    }

    // =====================================================================
    // Chance-weight convention (corrected 2026-09-01)
    // =====================================================================

    /// Board As Ks Qs, OOP JsTs — a made royal flush, immortal on every runout — versus
    /// IP 2c2d, drawing stone dead. Pot 10, stack 10, one 100%-pot sizing, so OOP's bet
    /// is the whole stack and IP's only correct reply is to fold.
    ///
    /// OOP takes the 10-chip pot on every line, so its zero-sum EV is exactly +5 whether
    /// the solve starts on the flop, the turn or the river, and checking and shoving are
    /// exactly indifferent. None of the four hole cards is on the board, so every chance
    /// node blocks exactly four of its outcomes for this pair — the case the old uniform
    /// `1/outcomes` weights got wrong.
    fn immortal_royal_cfg(board: &str) -> SolveConfig {
        let mut cfg = SolveConfig {
            board: board.to_string(),
            oop_range: "JsTs".to_string(),
            ip_range: "2c2d".to_string(),
            effective_stack: 10.0,
            starting_pot: 10.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        for p in [0u8, 1] {
            let s = if p == 0 { &mut cfg.sizings.oop } else { &mut cfg.sizings.ip };
            s.flop.bet = Sizings::new(&[100.0], false);
            s.turn.bet = Sizings::new(&[100.0], false);
            s.river.bet = Sizings::new(&[100.0], false);
        }
        cfg
    }

    /// REGRESSION. Terminals above a chance node must be measured on the same scale as
    /// terminals below it. With uniform `1/outcomes` weights they were not: a flop fold
    /// kept a full unit of mass while a runout kept only `(45/49)(44/48)`, so this spot
    /// reported EV(OOP) = 5.9394 on a flop start (5 * (49*48)/(45*44)) and 5.4545 on a
    /// turn start, and the free choice between checking and shoving collapsed to a
    /// forced shove.
    #[test]
    fn immortal_royal_is_worth_half_the_pot_at_every_chance_depth() {
        for board in ["As Ks Qs", "As Ks Qs 3h", "As Ks Qs 3h 4d"] {
            let cfg = immortal_royal_cfg(board);
            let (s, _) = solve(&cfg, 1_000, 0);
            let g = s.game();
            assert_eq!((g.combo_count(0, 0), g.combo_count(0, 1)), (1, 1));

            let (v0, v1) = (s.expected_value(0), s.expected_value(1));
            println!(
                "royal on {board:>14}: EV(OOP) {v0:.6}  EV(IP) {v1:.6}  sum {:.9}  (theory +5/-5)",
                v0 + v1
            );
            assert!((v0 - 5.0).abs() < 1e-3, "{board}: OOP EV {v0} != +5, half the pot");
            assert!((v0 + v1).abs() < 1e-3, "{board}: not zero-sum: {v0} + {v1}");

            // Indifference: both lines end with OOP taking the same 10 chips.
            let ip_reach = g.root_weights(1);
            let avg = s.average();
            let ev_of = |child: u32| {
                let mut v = vec![0.0f32; 1];
                br::subtree_values(g, child, 0, &avg, ip_reach, false, &mut v);
                v[0] / g.compatible_mass(0, 0, ip_reach)[0]
            };
            let ev_check = ev_of(action(g, 0, ActionLabel::Check));
            let ev_shove = ev_of(action(g, 0, ActionLabel::AllIn));
            println!("royal on {board:>14}: EV(check) {ev_check:.6}  EV(shove) {ev_shove:.6}");
            assert!(
                (ev_check - ev_shove).abs() < 1e-2,
                "{board}: check {ev_check} and shove {ev_shove} are not indifferent"
            );
        }
    }

    /// Runout mass a single compatible pair accumulates below `node`, by multiplying the
    /// deal weights along every runout the pair can actually see. Both ranges must hold
    /// exactly one combo, so "the pair survives this deal" is just "the child is nonempty".
    fn enumerated_runout_mass(g: &NlheGame, node: u32) -> f64 {
        match g.node(node) {
            NodeInfo::Terminal => 1.0,
            NodeInfo::Decision { .. } => enumerated_runout_mass(g, g.child(node, 0)),
            NodeInfo::Chance { num_outcomes } => (0..num_outcomes)
                .map(|k| {
                    let e = g.chance_outcome(node, k);
                    if e.parent_of_child[0].is_empty() || e.parent_of_child[1].is_empty() {
                        0.0
                    } else {
                        e.weight as f64 * enumerated_runout_mass(g, e.child)
                    }
                })
                .sum(),
        }
    }

    /// REGRESSION. The invariant the old weights violated: one compatible pair
    /// accumulates exactly one unit of runout mass, at every chance depth, so a terminal
    /// above the chance nodes and a terminal below them are directly comparable.
    #[test]
    fn one_compatible_pair_accumulates_exactly_one_unit_of_runout_mass() {
        for board in ["As Kd 7h", "As Kd 7h 3c"] {
            let mut cfg = flop_checkdown_cfg("AhKh", "7s7d");
            cfg.board = board.to_string();
            let g = NlheGame::new(&cfg).expect("builds");
            assert_eq!((g.combo_count(0, 0), g.combo_count(0, 1)), (1, 1));
            let mass = enumerated_runout_mass(&g, g.root());
            println!("enumerated runout mass on {board:>11}: {mass:.9} (must be exactly 1)");
            assert!((mass - 1.0).abs() < 1e-6, "{board}: runout mass {mass} != 1");
        }
    }

    #[test]
    fn normalizer_matches_a_direct_runout_enumeration() {
        // River: no chance mass at all.
        assert_normalizer_matches_enumeration(&milestone3_cfg());

        // Turn: one card to come, non-uniform weights, overlapping ranges.
        let turn = SolveConfig {
            board: "As Kd 7h 2c".to_string(),
            oop_range: "QQ+,AKs:0.5,76s".to_string(),
            ip_range: "JJ-88,AQo:0.25,A5s".to_string(),
            effective_stack: 50.0,
            starting_pot: 10.0,
            ..SolveConfig::default()
        };
        assert_normalizer_matches_enumeration(&turn);

        // Flop: two cards to come, full ranges.
        assert_normalizer_matches_enumeration(&flop_checkdown_cfg("random", "random"));
    }

    // =====================================================================
    // Payoff algebra
    // =====================================================================

    /// Every terminal is exactly zero-sum per joint combo pair, rake-free: probing one
    /// combo at a time with a unit opponent reach recovers `u0(i,j) + u1(j,i) == 0`.
    #[test]
    fn every_terminal_is_zero_sum_per_combo_pair() {
        let cfg = milestone3_cfg();
        let g = NlheGame::new(&cfg).expect("builds");
        let terminals: Vec<u32> = (0..g.num_nodes() as u32)
            .filter(|&i| matches!(g.node(i), NodeInfo::Terminal))
            .collect();
        assert_eq!(terminals.len(), 5);

        for &t in &terminals {
            let n0 = g.combo_count(t, 0);
            let n1 = g.combo_count(t, 1);
            for j in 0..n1 {
                let mut reach1 = vec![0.0f32; n1];
                reach1[j] = 1.0;
                let mut u0 = vec![0.0f32; n0];
                g.terminal_utility(t, 0, &reach1, &mut u0);
                for i in 0..n0 {
                    let mut reach0 = vec![0.0f32; n0];
                    reach0[i] = 1.0;
                    let mut u1 = vec![0.0f32; n1];
                    g.terminal_utility(t, 1, &reach0, &mut u1);
                    assert!(
                        (u0[i] + u1[j]).abs() < 1e-4,
                        "terminal {t} pair ({i},{j}): {} + {} != 0",
                        u0[i],
                        u1[j]
                    );
                }
            }
        }
    }

    /// Rake turns the game constant-sum: the two utilities sum to `-rake` at every
    /// terminal that awards a pot, and a showdown chop splits the rake evenly.
    #[test]
    fn rake_makes_the_game_constant_sum() {
        let mut cfg = milestone3_cfg();
        cfg.rake = crate::config::Rake { percent: 5.0, cap: 0.0 };
        let g = NlheGame::new(&cfg).expect("builds");

        for t in (0..g.num_nodes() as u32).filter(|&i| matches!(g.node(i), NodeInfo::Terminal)) {
            let pot = g.node_at(t).pot;
            let rake = cfg.rake.amount(pot);
            let (n0, n1) = (g.combo_count(t, 0), g.combo_count(t, 1));
            let mut reach1 = vec![0.0f32; n1];
            reach1[0] = 1.0;
            let mut reach0 = vec![0.0f32; n0];
            reach0[0] = 1.0;
            let mut u0 = vec![0.0f32; n0];
            let mut u1 = vec![0.0f32; n1];
            g.terminal_utility(t, 0, &reach1, &mut u0);
            g.terminal_utility(t, 1, &reach0, &mut u1);
            assert!(
                (u0[0] + u1[0] + rake as f32).abs() < 1e-4,
                "terminal {t}: {} + {} != -rake {rake}",
                u0[0],
                u1[0]
            );
        }

        // Raked solve: exploitability is measured against a floor of -expected rake, so
        // the raw sum of best responses no longer bottoms out at zero.
        let mut s = Solver::new(g);
        s.run(3_000, &DcfrParams::default(), 0, |_, _, _| {});
        let (v0, v1) = (s.expected_value(0), s.expected_value(1));
        println!("raked EV: OOP {v0:.6} IP {v1:.6} sum {:.6} (negative = rake paid)", v0 + v1);
        assert!(v0 + v1 < -0.1, "raked values should sum to minus the expected rake");
    }

    #[test]
    fn construction_rejects_bad_input() {
        let mut cfg = milestone3_cfg();
        cfg.oop_range = "XX".to_string();
        assert!(NlheGame::new(&cfg).unwrap_err().contains("oop_range"));

        let mut cfg = milestone3_cfg();
        // Every combo of this range is on the board.
        cfg.ip_range = "KsKh".to_string();
        assert!(NlheGame::new(&cfg).unwrap_err().contains("ip_range"));

        let mut cfg = milestone3_cfg();
        cfg.board = "As Kd".to_string();
        assert!(NlheGame::new(&cfg).is_err());
    }

    #[test]
    fn zero_weight_combos_are_filtered_out_not_carried() {
        let mut cfg = milestone3_cfg();
        cfg.oop_range = "KK,A4s:0.0,A5s".to_string();
        let g = NlheGame::new(&cfg).expect("builds");
        assert_eq!(g.combo_count(0, 0), 3 + 4, "A4s at weight 0 must be absent");
        assert!(g.root_weights(0).iter().all(|&w| w > 0.0));
    }

    /// Regression: on flop/turn boards, per-combo EVs must be on the same chip scale as
    /// the aggregate. The identity that pins it, and which holds under any chance-weight
    /// convention: the (weight * mass)-weighted mean of `root_combo_evs` equals
    /// `expected_value(hero)`. Caught on a turn spot by the WASM smoke test 2026-09-01;
    /// the original test was river-only, where every convention agrees.
    #[test]
    fn root_combo_evs_weighted_mean_matches_expected_value_on_a_turn_board() {
        let mut cfg = flop_checkdown_cfg("QQ+,AKs,AQs,KJs", "TT+,AJs+,KQs");
        cfg.board = "Qs Jh 2h 8c".to_string();
        let g = NlheGame::new(&cfg).expect("builds");
        let mut solver = crate::cfr::Solver::new(g);
        solver.run(50, &crate::cfr::DcfrParams::default(), 0, |_, _, _| {});
        for hero in 0..2u8 {
            let evs = solver
                .game()
                .root_combo_evs(hero, &solver.average());
            let mass = solver.game().compatible_mass(
                0,
                hero,
                solver.game().root_weights(1 - hero),
            );
            let w = solver.game().root_weights(hero);
            let (mut num, mut den) = (0.0f64, 0.0f64);
            for i in 0..evs.len() {
                num += (w[i] * mass[i] * evs[i]) as f64;
                den += (w[i] * mass[i]) as f64;
            }
            let mean = (num / den) as f32;
            let ev = solver.expected_value(hero);
            assert!(
                (mean - ev).abs() < 2e-3,
                "player {hero}: weighted mean of per-combo EVs {mean} != range EV {ev}"
            );
        }
    }

    // =====================================================================
    // TOURNAMENT PAYOFFS (ICM)
    // =====================================================================
    //
    // One spot throughout: the milestone-3 river shape (Ks 7d 2c 8h 3d, KK/A4s/A5s
    // vs TT/JJ, disjoint card sets so no pair ever chops) rescaled to tournament
    // chips. Ten seats of 1500 behind, 300 already in the middle between the two
    // in-hand seats, one all-in sizing. A shove-call therefore moves 1650 chips,
    // more than a full starting stack, which is where ICM pressure lives.
    //
    // Two things make this the right spot. The ranges are disjoint, so every
    // showdown pair has a strict winner and `u0 + u1` is never the trivially-zero
    // chop case. And the tree has two chip-transfer magnitudes (150 at a
    // check-check showdown or a shove-fold, 1650 at a shove-call), so the leakage
    // has to *vary*: a constant-sum bug cannot hide in it.

    const T_STACKS: [f64; 10] = [1500.0; 10];
    /// A standard 10-man SNG ladder: the bubble is seat 4.
    const TOP_HEAVY: [f64; 3] = [500.0, 300.0, 200.0];
    /// Seven equal prizes out of ten seats: a satellite, where surviving is
    /// everything and winning chips is worth almost nothing.
    const SATELLITE: [f64; 7] = [100.0; 7];
    /// `sum(stacks) + starting_pot`, the chips at the table.
    const T_CHIPS: f64 = 15_000.0 + 300.0;

    /// The committed NashConv curve for `nashconv_falls_on_a_bubble_spot`: CSTE chips
    /// at every 1000th of 20000 iterations, measured on x86_64-pc-windows-msvc and
    /// identical with and without the `parallel` feature (this tree has no chance
    /// nodes, so there is nothing to fork). DCFR is not monotone report to report and
    /// this curve is not pinned as if it were; what is pinned is the shape and the
    /// magnitude, to 2%. If a change moves it, the change moved the ICM payoff map.
    const CURVE: [f32; 20] = [
        0.102616, 0.066776, 0.028905, 0.061686, 0.047737, 0.043317, 0.028395, 0.012058,
        0.011430, 0.024952, 0.017841, 0.005245, 0.023282, 0.008537, 0.006163, 0.010473,
        0.010642, 0.010539, 0.008914, 0.005733,
    ];

    fn bubble_cfg() -> SolveConfig {
        let mut cfg = SolveConfig {
            board: M3_BOARD.to_string(),
            oop_range: M3_OOP.to_string(),
            ip_range: M3_IP.to_string(),
            effective_stack: 1500.0,
            starting_pot: 300.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        cfg.sizings.oop.river.bet = Sizings::new(&[], true);
        cfg.sizings.ip.river.bet = Sizings::new(&[], true);
        cfg
    }

    fn with_payouts(payouts: &[f64]) -> SolveConfig {
        let mut cfg = bubble_cfg();
        cfg.tournament = Some(crate::config::Tournament {
            payouts: payouts.to_vec(),
            stacks: T_STACKS.to_vec(),
            seats: [0, 1],
        });
        cfg
    }

    /// Index of an action within its node's list, for indexing a strategy array.
    fn action_index(g: &NlheGame, node: u32, want: ActionLabel) -> usize {
        match &g.tree().node(node).kind {
            NodeKind::Decision { actions, .. } => actions
                .iter()
                .position(|a| a.label == want)
                .unwrap_or_else(|| panic!("no {want:?} at node {node}")),
            other => panic!("node {node} is not a decision: {other:?}"),
        }
    }

    /// Largest absolute difference between two solves' average strategies over every
    /// decision node, plus the number of entries compared.
    fn strategy_gap(a: &Solver<NlheGame>, b: &Solver<NlheGame>) -> (f32, usize) {
        assert_eq!(a.game().num_nodes(), b.game().num_nodes(), "same tree");
        let (mut worst, mut entries) = (0.0f32, 0usize);
        for idx in 0..a.game().num_nodes() as u32 {
            if !matches!(a.game().node(idx), NodeInfo::Decision { .. }) {
                continue;
            }
            let (sa, sb) = (a.average_strategy(idx), b.average_strategy(idx));
            assert_eq!(sa.len(), sb.len(), "node {idx}: strategy length");
            entries += sa.len();
            for (x, y) in sa.iter().zip(&sb) {
                worst = worst.max((x - y).abs());
            }
        }
        (worst, entries)
    }

    /// Winner-take-all with one prize equal to every chip at the table makes
    /// Malmuth-Harville exactly chip-proportional and the CSTE scale exactly 1, so the
    /// ICM payoff collapses to `award - stake`: the chip game. Not bit-identical on
    /// purpose, and the tolerance says so. The two branches reach the same number
    /// through different f64 arithmetic (a divide and a multiply through the DP,
    /// versus a subtraction).
    #[test]
    fn winner_take_all_reproduces_the_chip_solve() {
        let chips = bubble_cfg();
        let wta = with_payouts(&[T_CHIPS]);

        let (a, _) = solve(&chips, 4_000, 0);
        let (b, _) = solve(&wta, 4_000, 0);
        assert!(a.game().zero_sum(), "a chip solve is zero-sum");
        assert!(!b.game().zero_sum(), "an ICM solve is general-sum, WTA included");

        let (worst, entries) = strategy_gap(&a, &b);
        let (ra, rb) = (a.exploitability(), b.exploitability());
        println!(
            "WTA vs chipEV: {} nodes, {entries} strategy entries compared, worst |diff| \
             {worst:.3e} (tol 1e-4)",
            a.game().num_nodes()
        );
        println!(
            "WTA vs chipEV: NashConv {:.6} vs exploitability {:.6} chips, EV0 {:.6} vs {:.6}",
            rb.chips,
            ra.chips,
            b.expected_value(0),
            a.expected_value(0)
        );
        assert!(worst < 1e-4, "strategies moved by {worst}");
        assert!(
            (rb.chips - ra.chips).abs() < 1e-4,
            "NashConv {} vs exploitability {}",
            rb.chips,
            ra.chips
        );
    }

    /// The invariant that replaces zero-sum. Chips moving between two seats destroys
    /// equity for the pair and hands it to the frozen field, so `u0 + u1 < 0` at every
    /// terminal, and by a *different* amount at each because the terminals move
    /// different numbers of chips. A constant-sum implementation (the mistake the
    /// engine map made) passes a plain non-zero check and fails the variance one.
    #[test]
    fn icm_leaks_equity_to_the_field() {
        let g = NlheGame::new(&with_payouts(&TOP_HEAVY)).expect("builds");
        let scale = T_CHIPS / TOP_HEAVY.iter().sum::<f64>();
        let terminals: Vec<u32> = (0..g.num_nodes() as u32)
            .filter(|&i| matches!(g.node(i), NodeInfo::Terminal))
            .collect();
        assert_eq!(terminals.len(), 5, "two folds and three showdowns");

        let mut per_terminal = Vec::new();
        let mut pairs = 0usize;
        let mut worst = 0.0f32;
        for &t in &terminals {
            let (n0, n1) = (g.combo_count(t, 0), g.combo_count(t, 1));
            let mut sum_00 = 0.0f32;
            for j in 0..n1 {
                let mut reach1 = vec![0.0f32; n1];
                reach1[j] = 1.0;
                let mut u0 = vec![0.0f32; n0];
                g.terminal_utility(t, 0, &reach1, &mut u0);
                for i in 0..n0 {
                    let mut reach0 = vec![0.0f32; n0];
                    reach0[i] = 1.0;
                    let mut u1 = vec![0.0f32; n1];
                    g.terminal_utility(t, 1, &reach0, &mut u1);
                    let leak = u0[i] + u1[j];
                    pairs += 1;
                    worst = worst.min(leak);
                    assert!(
                        leak < 0.0,
                        "terminal {t} pair ({i},{j}): {} + {} = {leak}, not a loss to the field",
                        u0[i],
                        u1[j]
                    );
                    if i == 0 && j == 0 {
                        sum_00 = leak;
                    }
                }
            }
            per_terminal.push((t, g.node_at(t).pot, sum_00));
        }

        println!(
            "icm leakage: {} terminals, {pairs} combo pairs probed, CSTE scale {scale:.4}",
            terminals.len()
        );
        for (t, pot, leak) in &per_terminal {
            println!(
                "  terminal {t:>2}  pot {pot:>7.1}  u0+u1 = {leak:+.4} CSTE ({:+.4} in payout units)",
                *leak as f64 / scale
            );
        }
        let lo = per_terminal.iter().map(|x| x.2).fold(f32::MAX, f32::min);
        let hi = per_terminal.iter().map(|x| x.2).fold(f32::MIN, f32::max);
        println!("  spread {lo:+.4} .. {hi:+.4} CSTE, worst pair {worst:+.4}");
        assert!(
            hi - lo > 1.0,
            "leakage is nearly constant ({lo} .. {hi}); a constant-sum bug looks like this"
        );
    }

    /// Negative control on the whole feature: a payoff map that quietly did nothing
    /// would still pass the winner-take-all gate. Seven equal prizes out of ten seats
    /// make survival almost everything, and the strategy has to move a long way.
    #[test]
    fn satellite_moves_the_strategy() {
        let (chip, _) = solve(&bubble_cfg(), 4_000, 0);
        let (top, _) = solve(&with_payouts(&TOP_HEAVY), 4_000, 0);
        let (sat, _) = solve(&with_payouts(&SATELLITE), 4_000, 0);

        let g = chip.game();
        let root = g.root();
        let shove = action_index(g, root, ActionLabel::AllIn);
        let facing = action(g, root, ActionLabel::AllIn);
        let call = action_index(g, facing, ActionLabel::Call);
        let air = slots_for(g, 0, &AIR);
        let bluffcatch: Vec<usize> = BLUFFCATCH.iter().map(|t| slot(g, facing, 1, t)).collect();
        let (n_oop, n_ip) = (g.combo_count(root, 0), g.combo_count(facing, 1));

        let read = |s: &Solver<NlheGame>| {
            let bluff = freq(&s.average_strategy(root), n_oop, shove, &air) * 100.0;
            let defend = freq(&s.average_strategy(facing), n_ip, call, &bluffcatch) * 100.0;
            (bluff, defend)
        };
        let (b_chip, d_chip) = read(&chip);
        let (b_top, d_top) = read(&top);
        let (b_sat, d_sat) = read(&sat);

        println!(
            "aggression at node {root} (OOP shoves air) and node {facing} (IP calls a \
             bluffcatcher), over {} air combos / {} bluffcatchers:",
            air.len(),
            bluffcatch.len()
        );
        println!("  chipEV      bluff {b_chip:6.2}%  defend {d_chip:6.2}%");
        println!("  top-heavy   bluff {b_top:6.2}%  defend {d_top:6.2}%");
        println!("  satellite   bluff {b_sat:6.2}%  defend {d_sat:6.2}%");

        println!(
            "  MAGNITUDE SANITY (printed, not asserted): the flatter the ladder the less \
             a bluffcatcher can call, {d_chip:.2}% -> {d_top:.2}% -> {d_sat:.2}%, and the \
             more the shover gets away with, {b_chip:.2}% -> {b_top:.2}% -> {b_sat:.2}%. \
             The published 66%/82% flop-check figure is for a 30bb SRP, a spot this \
             river tree cannot produce."
        );

        let moved = (b_sat - b_chip).abs().max((d_sat - d_chip).abs());
        assert!(
            moved > 10.0,
            "satellite ICM moved no frequency more than {moved:.2} points; the payoff map \
             is not reaching the strategy"
        );
    }

    /// The chop is not the midpoint under ICM. Equity is concave in chips, so a split
    /// pot, where no chips move at all, is worth strictly more than half of winning
    /// plus half of losing. Deriving `chop` from `win`/`lose`, which is what the code
    /// did before Stage 1b, silently taxes every tie.
    #[test]
    fn icm_chop_is_not_the_midpoint() {
        // Both players hold exactly QQ on a board that pairs nothing they hold, so
        // every non-conflicting pair is a dead heat.
        let mut cfg = with_payouts(&TOP_HEAVY);
        cfg.board = "Ah Kd 7c 5s 2d".to_string();
        cfg.oop_range = "QQ".to_string();
        cfg.ip_range = "QQ".to_string();
        let g = NlheGame::new(&cfg).expect("builds");

        // The all-in showdown: the biggest pot in the tree, so the biggest concavity.
        let showdown = (0..g.num_nodes() as u32)
            .filter(|&i| matches!(g.node(i), NodeInfo::Terminal))
            .max_by(|&a, &b| g.node_at(a).pot.total_cmp(&g.node_at(b).pot))
            .expect("a terminal");
        let t = &g.terms[g.node_aux[showdown as usize] as usize];
        let midpoint = [(t.win[0] + t.lose[0]) * 0.5, (t.win[1] + t.lose[1]) * 0.5];
        println!(
            "terminal {showdown} (pot {:.1}): win {:?} lose {:?} chop {:?}",
            g.node_at(showdown).pot,
            t.win,
            t.lose,
            t.chop
        );
        for (p, &mid) in midpoint.iter().enumerate() {
            let margin = t.chop[p] - mid;
            println!(
                "  player {p}: chop {:+.6} vs midpoint {mid:+.6}, margin {margin:+.6} CSTE",
                t.chop[p]
            );
            assert!(
                t.chop[p].abs() < 1e-3,
                "player {p}: a split pot moves no chips, so it must pay ~0, got {}",
                t.chop[p]
            );
            assert!(
                margin > 1.0,
                "player {p}: chop {} is only {margin} above the midpoint {mid}; the \
                 concavity is not being expressed",
                t.chop[p]
            );
        }

        // ...and the value really does reach the payoff path, not just the table: a
        // tying pair nets both players exactly 0 through `terminal_utility`.
        let (n0, n1) = (g.combo_count(showdown, 0), g.combo_count(showdown, 1));
        let mut probed = 0usize;
        for j in 0..n1 {
            let mut reach1 = vec![0.0f32; n1];
            reach1[j] = 1.0;
            let mut u0 = vec![0.0f32; n0];
            g.terminal_utility(showdown, 0, &reach1, &mut u0);
            for i in 0..n0 {
                let mut reach0 = vec![0.0f32; n0];
                reach0[i] = 1.0;
                let mut u1 = vec![0.0f32; n1];
                g.terminal_utility(showdown, 1, &reach0, &mut u1);
                probed += 1;
                assert!(
                    u0[i].abs() < 1e-3 && u1[j].abs() < 1e-3,
                    "QQ vs QQ pair ({i},{j}) is not paid as a chop: {} / {}",
                    u0[i],
                    u1[j]
                );
            }
        }
        println!("  {probed} QQ-vs-QQ pairs probed, all paid ~0 to both players");
    }

    /// Fail-on-purpose on the metric itself. A player locked to always fold to the
    /// shove is playing a strategy that is terrible in the *unlocked* game, and `gain`
    /// has to say so loudly. Measuring the locked profile inside its own locked game
    /// reports far less by construction, because the lock is not a deviation the best
    /// response is allowed to take, so the measurement is made against the game
    /// without the lock. Both numbers are printed.
    #[test]
    fn a_locked_folder_has_an_exploding_gain() {
        let mut locked = with_payouts(&TOP_HEAVY);
        locked.locks = vec![crate::config::NodeLock {
            line: ActionLabel::AllIn.token(),
            player: 1,
            freqs: Some(vec![1.0, 0.0]),
            strategy: None,
        }];
        let (s, _) = solve(&locked, 2_000, 0);

        let free = NlheGame::new(&with_payouts(&TOP_HEAVY)).expect("builds");
        let inside = s.exploitability();
        let outside = br::exploitability(&free, &s.average());
        let pot = free.root_pot();
        println!(
            "locked IP folds to every shove: inside the locked game gain {:?}, NashConv \
             {:.4} = {:.3}% of pot",
            inside.gain, inside.chips, inside.pct_of_pot
        );
        println!(
            "  measured in the unlocked game: gain {:?}, NashConv {:.4} CSTE chips = \
             {:.3}% of pot {pot}",
            outside.gain, outside.chips, outside.pct_of_pot
        );
        let ip_pct = 100.0 * outside.gain[1] / pot;
        println!("  IP's own gain is {ip_pct:.3}% of pot");
        assert!(
            ip_pct > 5.0,
            "IP folds every shove and `gain` only calls it {ip_pct}% of pot"
        );
    }

    /// In the chip game `gain` is the best-response value itself, bit for bit, and the
    /// two sum to exactly the number this crate has always called exploitability. That
    /// identity is what makes the new field free on the chip path.
    #[test]
    fn gain_is_the_best_response_value_in_the_chip_game() {
        for (name, cfg) in [("milestone 3", milestone3_cfg()), ("bubble shape", bubble_cfg())] {
            let (s, _) = solve(&cfg, 2_000, 0);
            let r = s.exploitability();
            assert!(s.game().zero_sum(), "{name}: a chip game is zero-sum");
            assert_eq!(r.gain, r.br, "{name}: gain must be br exactly");
            assert_eq!(
                r.gain[0] + r.gain[1],
                r.chips,
                "{name}: gain must sum to the reported figure"
            );
            println!("{name}: br {:?} gain {:?} chips {:.9}", r.br, r.gain, r.chips);
        }
    }

    /// Convergence evidence for an ICM spot, committed the way the chipEV milestones
    /// are: the NashConv curve on the 10-man bubble, in CSTE chips and percent of pot,
    /// with the volume it was measured over beside it.
    #[test]
    fn nashconv_falls_on_a_bubble_spot() {
        let cfg = with_payouts(&TOP_HEAVY);
        let g = NlheGame::new(&cfg).expect("builds");
        let nodes = g.num_nodes();
        let terms = (0..g.num_nodes() as u32)
            .filter(|&i| matches!(g.node(i), NodeInfo::Terminal))
            .count();
        let (s, log) = solve(&cfg, 20_000, 1_000);
        println!(
            "bubble NashConv curve: {nodes} nodes ({terms} terminal), root combos {}v{}, \
             20000 iterations, payouts {TOP_HEAVY:?} over {} seats, {} in-hand seats at \
             {} chips each",
            g.combo_count(0, 0),
            g.combo_count(0, 1),
            T_STACKS.len(),
            2,
            T_STACKS[0]
        );
        assert_eq!(log.len(), CURVE.len(), "one report per pinned checkpoint");
        for ((i, chips, pct), &want) in log.iter().zip(&CURVE) {
            println!(
                "  iter {i:>6}  NashConv {chips:.6} CSTE chips  {pct:.6}% of pot  \
                 (committed {want:.6})"
            );
            assert!(
                (chips - want).abs() <= 0.02 * want,
                "iter {i}: NashConv {chips} is more than 2% off the committed {want}"
            );
        }
        let first = log.first().expect("a report").1;
        let last = log.last().expect("a report").1;
        assert!(last > 0.0, "NashConv is a non-negative quantity, got {last}");
        assert!(
            last < first / 5.0,
            "NashConv {last} is not 5x below its first report {first}"
        );
        let r = s.exploitability();
        assert!(r.pct_of_pot < 0.5, "final NashConv {}% of pot", r.pct_of_pot);
    }

    /// `ev_pot_share` keeps its meaning under ICM: the seat's absolute worth right
    /// now, in the unit the solve is scored in. Chip solves are untouched.
    #[test]
    fn ev_pot_share_reports_absolute_equity_under_icm() {
        let (chip, _) = solve(&bubble_cfg(), 500, 0);
        let g = chip.game();
        for hero in 0..2u8 {
            let ev = chip.expected_value(hero);
            assert_eq!(
                g.ev_pot_share(hero, ev),
                ev + (g.config().starting_pot * 0.5) as f32,
                "chip path unchanged"
            );
        }

        let (icm_solve, _) = solve(&with_payouts(&TOP_HEAVY), 500, 0);
        let g = icm_solve.game();
        let shares: Vec<f32> = (0..2u8)
            .map(|h| g.ev_pot_share(h, icm_solve.expected_value(h)))
            .collect();
        // Each seat starts the hand worth roughly a tenth of the 1000-unit prize pool;
        // in CSTE that is 100 * scale.
        let scale = T_CHIPS / TOP_HEAVY.iter().sum::<f64>();
        let flat = 100.0 * scale;
        println!(
            "ICM ev_pot_share: OOP {:.2}  IP {:.2} CSTE chips (an untouched 1/10th seat is \
             {flat:.2}, scale {scale:.4})",
            shares[0], shares[1]
        );
        for (h, &v) in shares.iter().enumerate() {
            assert!(
                (v as f64 - flat).abs() < 400.0,
                "seat {h} is worth {v} CSTE, nowhere near a live seat's {flat}"
            );
        }
    }

    #[test]
    fn board_at_a_chance_node_is_the_board_before_its_own_deal() {
        let g = NlheGame::new(&flop_checkdown_cfg("TT+", "99+")).expect("builds");
        let turn_chance = (0..g.num_nodes() as u32)
            .find(|&i| matches!(g.node(i), NodeInfo::Chance { .. }))
            .unwrap();
        assert_eq!(g.board_at(turn_chance).len(), 3);
        let e = g.chance_outcome(turn_chance, 0);
        assert_eq!(g.board_at(e.child).len(), 4);
        assert_eq!(g.combo_count(e.child, 0), e.parent_of_child[0].len());
    }
}
