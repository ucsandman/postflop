//! `solver show`: inspect a saved solution without re-solving.
//!
//! Reloading only ever rebuilds deterministic structure — [`NlheGame::new`] parses
//! the embedded config and builds the tree and board tables, exactly like a fresh
//! solve's setup phase, but the CFR solver itself is never constructed or run.

use std::collections::HashMap;
use std::path::PathBuf;

use clap::Args;
use engine::cards::{self, Card, RANK_CHARS};
use engine::nlhe::NlheGame;
use engine::solution::{NodeStrategy, Solution};
use engine::tree::{Action, ActionLabel, GameTree, NodeKind};

#[derive(Args)]
pub struct ShowArgs {
    /// Path to a saved solution file.
    #[arg(long)]
    solution: PathBuf,

    /// Action path from the root, comma-separated, e.g. "check,bet:75,call".
    /// "bet:PCT"/"raise:PCT" match the sizing whose percent-of-pot rounds to PCT;
    /// "fold"/"check"/"call"/"allin" match literally. Omit to show the root.
    #[arg(long)]
    line: Option<String>,

    /// Print this exact combo's action distribution instead of the rank grid,
    /// e.g. "AhKh".
    #[arg(long)]
    combo: Option<String>,
}

pub fn run(args: ShowArgs) -> Result<(), String> {
    let sol = Solution::load(&args.solution)?;
    let game = NlheGame::new(&sol.config)?;
    let tree = game.tree();
    let by_node: HashMap<u32, &NodeStrategy> = sol.nodes.iter().map(|n| (n.node, n)).collect();

    let node = navigate(tree, args.line.as_deref())?;
    print_node_header(&game, node);

    let NodeKind::Decision { player, actions } = &tree.node(node).kind else {
        if args.combo.is_some() {
            return Err(format!(
                "node {node} is not a decision node; --combo has nothing to show"
            ));
        }
        println!(
            "node {node} is not a decision node ({:?}); nothing to show.",
            tree.node(node).kind
        );
        return Ok(());
    };
    let ns = by_node.get(&node).copied().ok_or_else(|| {
        format!("node {node} is a decision node but has no strategy recorded in this solution file")
    })?;

    match &args.combo {
        Some(combo) => print_combo(tree, node, *player, actions, ns, &game, combo),
        None => {
            print_rank_grid(tree, node, *player, actions, ns, &game);
            Ok(())
        }
    }
}

/// Walks `line` (comma-separated action tokens) from the root, matching each token
/// against the decision node it lands on. Empty or absent `line` means the root.
fn navigate(tree: &GameTree, line: Option<&str>) -> Result<u32, String> {
    let mut node = tree.root();
    let Some(line) = line else { return Ok(node) };
    for (step, token) in line
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .enumerate()
    {
        let NodeKind::Decision { player, actions } = &tree.node(node).kind else {
            return Err(format!(
                "line step {step} (\"{token}\"): node {node} is not a decision node ({:?})",
                tree.node(node).kind
            ));
        };
        let idx = match_action(tree, node, *player, actions, token).ok_or_else(|| {
            let have: Vec<String> = actions
                .iter()
                .map(|a| describe_action(tree, node, *player, actions, a))
                .collect();
            format!(
                "line step {step}: no action matches \"{token}\" at node {node}; have [{}]",
                have.join(", ")
            )
        })?;
        node = actions[idx].child;
    }
    Ok(node)
}

/// Matches one `--line` token against the actions available at a node. Literal
/// tokens (`fold`/`check`/`call`/`allin`) match by label; `bet:PCT`/`raise:PCT`
/// match the sizing whose percent-of-pot (see [`action_percent`]) rounds to `PCT`.
fn match_action(
    tree: &GameTree,
    node: u32,
    player: u8,
    actions: &[Action],
    token: &str,
) -> Option<usize> {
    let low = token.to_ascii_lowercase();
    if let Some(pct_str) = low.strip_prefix("bet:") {
        let want: i64 = pct_str.trim().parse().ok()?;
        return actions.iter().position(|a| {
            matches!(a.label, ActionLabel::Bet(_))
                && action_percent(tree, node, player, actions, a).map(|p| p.round() as i64) == Some(want)
        });
    }
    if let Some(pct_str) = low.strip_prefix("raise:") {
        let want: i64 = pct_str.trim().parse().ok()?;
        return actions.iter().position(|a| {
            matches!(a.label, ActionLabel::Raise(_))
                && action_percent(tree, node, player, actions, a).map(|p| p.round() as i64) == Some(want)
        });
    }
    let want_label = match low.as_str() {
        "fold" => ActionLabel::Fold,
        "check" => ActionLabel::Check,
        "call" => ActionLabel::Call,
        "allin" => ActionLabel::AllIn,
        _ => return None,
    };
    actions.iter().position(|a| a.label == want_label)
}

/// Percent-of-pot for a bet or raise action, computed the same way
/// [`engine::config::SolveConfig`]'s sizing tables define it (see that module's
/// docs): a bet's percent is against the pot at this node; a raise's percent is
/// against the pot as it would be after calling. `None` for fold/check/call/all-in,
/// which are matched literally rather than by percent.
fn action_percent(
    tree: &GameTree,
    node: u32,
    player: u8,
    actions: &[Action],
    action: &Action,
) -> Option<f64> {
    let n = tree.node(node);
    match action.label {
        ActionLabel::Bet(amount) => Some(100.0 * amount / n.pot),
        ActionLabel::Raise(_) => {
            let call = actions.iter().find(|a| matches!(a.label, ActionLabel::Call))?;
            let post_call_pot = tree.node(call.child).pot;
            let to_call = post_call_pot - n.pot;
            let added = n.stacks[player as usize] - tree.node(action.child).stacks[player as usize];
            let increment = added - to_call;
            Some(100.0 * increment / post_call_pot)
        }
        _ => None,
    }
}

/// Short grid/legend code: "F"/"X"/"C"/"A" or "B<pct>"/"R<pct>".
fn short_code(tree: &GameTree, node: u32, player: u8, actions: &[Action], action: &Action) -> String {
    match action.label {
        ActionLabel::Fold => "F".to_string(),
        ActionLabel::Check => "X".to_string(),
        ActionLabel::Call => "C".to_string(),
        ActionLabel::AllIn => "A".to_string(),
        ActionLabel::Bet(_) => {
            let pct = action_percent(tree, node, player, actions, action).unwrap_or(f64::NAN);
            format!("B{}", pct.round() as i64)
        }
        ActionLabel::Raise(_) => {
            let pct = action_percent(tree, node, player, actions, action).unwrap_or(f64::NAN);
            format!("R{}", pct.round() as i64)
        }
    }
}

fn describe_action(tree: &GameTree, node: u32, player: u8, actions: &[Action], action: &Action) -> String {
    match action.label {
        ActionLabel::Fold => "fold".to_string(),
        ActionLabel::Check => "check".to_string(),
        ActionLabel::Call => "call".to_string(),
        ActionLabel::AllIn => "allin".to_string(),
        ActionLabel::Bet(amount) => {
            let pct = action_percent(tree, node, player, actions, action).unwrap_or(f64::NAN);
            format!("bet:{} ({amount:.2} chips, {pct:.1}% pot)", pct.round() as i64)
        }
        ActionLabel::Raise(amount) => {
            let pct = action_percent(tree, node, player, actions, action).unwrap_or(f64::NAN);
            format!("raise:{} (to {amount:.2} chips, {pct:.1}% pot)", pct.round() as i64)
        }
    }
}

fn label_text(label: ActionLabel) -> String {
    match label {
        ActionLabel::Fold => "fold".to_string(),
        ActionLabel::Check => "check".to_string(),
        ActionLabel::Call => "call".to_string(),
        ActionLabel::AllIn => "all-in".to_string(),
        ActionLabel::Bet(x) => format!("bet to {x:.2}"),
        ActionLabel::Raise(x) => format!("raise to {x:.2}"),
    }
}

fn print_node_header(game: &NlheGame, node: u32) {
    let n = game.node_at(node);
    println!(
        "node {node}: street {:?}  board {}  pot {:.2}  stacks [OOP {:.2}, IP {:.2}]",
        n.street,
        cards::cards_to_string(game.board_at(node)),
        n.pot,
        n.stacks[0],
        n.stacks[1]
    );
}

/// `(high_rank, low_rank, suited)`. Pairs always come out `suited = false` since a
/// pair's two cards necessarily differ in suit.
fn bucket_key(a: Card, b: Card) -> (u8, u8, bool) {
    let (ra, rb) = (cards::rank(a), cards::rank(b));
    let suited = cards::suit(a) == cards::suit(b);
    if ra >= rb {
        (ra, rb, suited)
    } else {
        (rb, ra, suited)
    }
}

/// 13x13 rank grid: per cell, the dominant action and its frequency, averaged
/// uniformly (weight 1 per combo) over the live combos in that cell — the same
/// convention the engine's own tests use for per-bucket frequencies.
fn print_rank_grid(
    tree: &GameTree,
    node: u32,
    player: u8,
    actions: &[Action],
    ns: &NodeStrategy,
    game: &NlheGame,
) {
    let combo_count = ns.combo_count as usize;
    let codes: Vec<String> = actions
        .iter()
        .map(|a| short_code(tree, node, player, actions, a))
        .collect();

    let mut buckets: HashMap<(u8, u8, bool), Vec<usize>> = HashMap::new();
    for (i, &(a, b)) in game.live_combos(node, player).iter().enumerate() {
        buckets.entry(bucket_key(a, b)).or_default().push(i);
    }

    const COL_WIDTH: usize = 9;
    print!("     ");
    for g in 0..13 {
        print!("{:>COL_WIDTH$}", RANK_CHARS[12 - g]);
    }
    println!();
    for g_row in 0..13usize {
        print!("{:>4} ", RANK_CHARS[12 - g_row]);
        for g_col in 0..13usize {
            let rank_row = (12 - g_row) as u8;
            let rank_col = (12 - g_col) as u8;
            let key = if g_row == g_col {
                (rank_row, rank_row, false)
            } else if g_row < g_col {
                (rank_row, rank_col, true)
            } else {
                (rank_row, rank_col, false)
            };
            let cell = match buckets.get(&key) {
                None => "--".to_string(),
                Some(slots) if slots.is_empty() => "--".to_string(),
                Some(slots) => {
                    let (mut best_a, mut best_freq) = (0usize, -1.0f32);
                    for a in 0..actions.len() {
                        let f = slots
                            .iter()
                            .map(|&i| ns.strategy[a * combo_count + i])
                            .sum::<f32>()
                            / slots.len() as f32;
                        if f > best_freq {
                            best_freq = f;
                            best_a = a;
                        }
                    }
                    format!("{:<4}{:>3.0}%", codes[best_a], best_freq * 100.0)
                }
            };
            print!("{cell:>COL_WIDTH$}");
        }
        println!();
    }
    println!();
    let legend: Vec<String> = codes
        .iter()
        .zip(actions)
        .map(|(c, a)| format!("{c}={}", label_text(a.label)))
        .collect();
    println!("legend: {}", legend.join("  "));
}

/// One combo's exact action distribution at `node`.
fn print_combo(
    tree: &GameTree,
    node: u32,
    player: u8,
    actions: &[Action],
    ns: &NodeStrategy,
    game: &NlheGame,
    combo: &str,
) -> Result<(), String> {
    let parsed = cards::parse_cards(combo).map_err(|e| format!("--combo {combo:?}: {e}"))?;
    if parsed.len() != 2 {
        return Err(format!("--combo {combo:?} must name exactly 2 cards"));
    }
    let want = (parsed[0], parsed[1]);
    let combo_count = ns.combo_count as usize;
    let who = if player == 0 { "OOP" } else { "IP" };
    let slot = game
        .live_combos(node, player)
        .iter()
        .position(|&(a, b)| (a, b) == want || (b, a) == want)
        .ok_or_else(|| {
            format!("{combo} is not live for {who} at node {node} (blocked by the board or not in range)")
        })?;

    println!("combo {combo} ({who}):");
    for (a, action) in actions.iter().enumerate() {
        let code = short_code(tree, node, player, actions, action);
        let freq = ns.strategy[a * combo_count + slot];
        println!("  {code:<5} {:<16} {:.2}%", label_text(action.label), freq * 100.0);
    }
    Ok(())
}
