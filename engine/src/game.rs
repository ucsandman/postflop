//! The abstract game interface the CFR core and the best-response calculator run on.
//!
//! # What a `Game` is
//!
//! A two-player zero-sum extensive-form game in **vector form**. The tree is an arena
//! of nodes addressed by dense `u32` indices in `0..num_nodes()`. Every private state a
//! player can hold is a **combo** — in NLHE a specific two-card hand, in a toy game the
//! single dealt card. A traversal never visits combos one at a time; it carries a whole
//! `f32` vector, one slot per live combo, through the tree.
//!
//! # The two invariants the solver relies on
//!
//! 1. **Decision edges preserve combo sets.** `combo_count(node, p)` is equal for a
//!    decision node and every one of its children, and slot `i` means the same combo on
//!    both sides. Only chance edges may change a combo set.
//! 2. **Chance edges shrink combo sets monotonically.** The child's combo set is a
//!    *subsequence* of the parent's, in the same canonical ascending order. Combos that
//!    the dealt card kills are simply absent from the child, which is why NLHE counts go
//!    1176 -> 1128 -> 1081 down the runout instead of carrying dead zeros forever.
//!    [`ChanceEdge::parent_of_child`] is the map back into the parent's slots.
//!
//! Dead combos are *filtered out*, never zero-padded. A slot that exists is live.
//!
//! # Utility convention (zero-sum, net chips)
//!
//! [`Game::terminal_utility`] returns, for each live hero combo, the hero's
//! **counterfactual utility in chips**: the chips the hero nets *relative to the start
//! of the hand* — i.e. everything the hero drags out of the pot minus everything the
//! hero put in, antes and blinds included — summed over opponent combos and weighted by
//! `opp_reach`, with card removal applied exactly (impossible matchups contribute 0).
//!
//! For every joint combo pair `(i, j)` at every terminal this convention satisfies
//!
//! ```text
//! u0(i, j) + u1(j, i) == 0
//! ```
//!
//! That zero-sum property is what makes `best_response(0) + best_response(1)` a valid
//! exploitability measure (it is exactly 0 at Nash). A raked game is only constant-sum;
//! see [`Game::normalizer`] and `br::exploitability` for the consequence.
//!
//! # Scale, and how chip values are recovered
//!
//! Root weights are *not* required to be probabilities — an NLHE range is a bag of
//! weights, and card removal makes the joint distribution non-product anyway. So every
//! value the traversal produces is scaled by the total joint reach mass. Dividing by
//! [`Game::normalizer`] converts it back to chips per hand.

/// What kind of node an index addresses.
///
/// Cheap to produce: the solver calls this on every node visit, so implementations
/// should read it out of a flat array rather than build anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeInfo {
    /// A player is to act. `player` is 0 for OOP, 1 for IP.
    ///
    /// Actions are `0..num_actions`; the child of action `a` is
    /// [`Game::child`]`(node, a)`. `num_actions` must be at least 1.
    Decision { player: u8, num_actions: usize },
    /// A card (or other random event) is dealt. Outcomes are `0..num_outcomes`, each
    /// described by [`Game::chance_outcome`]. Outcomes that cannot happen (a card
    /// already on the board) must not be listed at all.
    Chance { num_outcomes: usize },
    /// A payoff node. Evaluate with [`Game::terminal_utility`].
    Terminal,
}

/// One outcome of a chance node, with everything a traversal needs to move both
/// players' vectors across the edge.
///
/// The two maps let the traversal do exactly two things:
///
/// * **compact** a parent reach vector into the child's shorter one:
///   `child[k] = parent[parent_of_child[p][k]]`
/// * **expand** a child counterfactual-value vector back into the parent's slots:
///   `parent[parent_of_child[p][k]] += child[k]`
///
/// Parent slots not named by the map are dead on this branch and contribute nothing,
/// so they are skipped rather than written.
pub struct ChanceEdge<'a> {
    /// Node index reached by this outcome.
    pub child: u32,
    /// Weight of this outcome, multiplied into the opponent's reach vector (and hence
    /// into every value returned from the subtree). Use the probability of the deal.
    pub weight: f32,
    /// `parent_of_child[p][k]` is the parent combo slot of player `p`'s child combo `k`.
    ///
    /// Length must equal `combo_count(child, p)`, and entries must be strictly
    /// ascending and less than `combo_count(node, p)`. Index 0 is player 0 (OOP).
    pub parent_of_child: [&'a [u32]; 2],
}

/// A two-player zero-sum game the vector CFR core can solve.
///
/// All slices are indexed by *live combo slot at the node in question*, never by a
/// global combo id. `player`/`hero` is 0 for OOP, 1 for IP.
pub trait Game {
    /// Index of the root node.
    fn root(&self) -> u32;

    /// Total number of nodes; valid indices are `0..num_nodes()`.
    fn num_nodes(&self) -> usize;

    /// Kind of `node`.
    fn node(&self, node: u32) -> NodeInfo;

    /// Child of decision `node` reached by `action` (`0..num_actions`).
    ///
    /// Only called on [`NodeInfo::Decision`] nodes.
    fn child(&self, node: u32, action: usize) -> u32;

    /// Number of live combos player `player` can hold at `node`.
    ///
    /// Constant across decision edges; may only shrink across chance edges.
    fn combo_count(&self, node: u32, player: u8) -> usize;

    /// Player `player`'s range weights at the root, one per combo slot at
    /// `root()`. Need not sum to 1 and need not be normalized; see
    /// [`Game::normalizer`].
    fn root_weights(&self, player: u8) -> &[f32];

    /// Describes outcome `outcome` of chance `node`.
    ///
    /// Only called on [`NodeInfo::Chance`] nodes.
    fn chance_outcome(&self, node: u32, outcome: usize) -> ChanceEdge<'_>;

    /// Hero's counterfactual utility at terminal `node`, in chips, one entry per live
    /// hero combo.
    ///
    /// `opp_reach` has `combo_count(node, 1 - hero)` entries and holds the opponent's
    /// reach probability (range weight times every opponent action probability and
    /// chance weight on the path). `out` has `combo_count(node, hero)` entries and must
    /// be **overwritten**, not accumulated into.
    ///
    /// The implementation must apply card removal exactly:
    ///
    /// ```text
    /// out[i] = sum over opponent combos j compatible with i of opp_reach[j] * u_hero(i, j)
    /// ```
    ///
    /// where `u_hero` is net chips per the module-level zero-sum convention. Combos
    /// sharing a card are impossible matchups and must be skipped, not merely
    /// down-weighted.
    fn terminal_utility(&self, node: u32, hero: u8, opp_reach: &[f32], out: &mut [f32]);

    /// Total joint root reach mass: the constant every counterfactual value carries.
    ///
    /// Formally, the sum over compatible root combo pairs `(i, j)` of
    /// `root_weights(0)[i] * root_weights(1)[j]`, times the total chance-weight mass of
    /// the tree (1 when chance weights are probabilities summing to 1 over live
    /// outcomes). Dividing a root counterfactual value by this gives chips per hand.
    ///
    /// Both players share one normalizer — the joint mass does not depend on whose
    /// perspective you take. Getting it wrong rescales every reported chip and
    /// percentage figure by a constant but does **not** affect solved strategies or the
    /// point at which exploitability reaches zero.
    fn normalizer(&self) -> f32;

    /// Pot at the root, in chips. Sole use is the denominator of the
    /// percent-of-pot exploitability figure, so it should be the same pot a human
    /// means when they say "0.3% of pot".
    fn root_pot(&self) -> f32;
}
