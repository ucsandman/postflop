//! NODE LOCKING — freeze a decision node, solve the rest of the tree around it.
//!
//! A lock pins the acting player's strategy at a node ([`SolveConfig::locks`]); CFR then
//! substitutes it for regret matching there and stops updating that player's regrets and
//! cumulative strategy at the node, while the best-response walk refuses to deviate from
//! it. What comes out is an equilibrium **conditional** on the locked play, which is the
//! whole point: it answers "what happens if my opponent plays like *this*", which a plain
//! solve cannot.
//!
//! Four gates, in the order they are worth trusting:
//!
//! 1. [`locking_oop_to_never_bluff_moves_ip_the_predicted_way`] — the feature does the
//!    thing. On a polarized river, freezing OOP to a pure-value betting range must drive
//!    IP's calling frequency down and IP's EV up, both strictly. Directions and bounds,
//!    never exact values: the equilibrium of a locked game is not something to hardcode.
//! 2. [`a_lock_on_every_node_reproduces_the_profile_exactly`] — the strongest check
//!    available, and it is bit-exact. Lock *every* node to a converged average strategy
//!    and the solve has nothing left to solve: the reported strategies must be the locks
//!    themselves, and the EVs must equal the unlocked run's to the last bit, because both
//!    are the same best-response walk over the same profile.
//! 3. [`a_no_op_lock_reproduces_the_unlocked_solution`] — locking one node to its own
//!    converged strategy must land back on the same solution, approximately. The
//!    approximation is the unlocked run's own residual exploitability, so the bound is
//!    stated against it rather than pulled from the air.
//! 4. [`a_locked_solve_is_thread_count_independent`] — determinism, on a real flop tree
//!    with chance forks, mirroring the milestone-4 gate. A lock is read-only shared state,
//!    so it must not disturb this; the test is here because "must not" is not evidence.
//!
//! Plus [`malformed_locks_are_rejected_when_the_game_is_built`], which is where a bad
//! line, a bad arity or an unnormalized row surfaces — resolution needs a tree, so
//! `NlheGame::new` is the real gate, not `SolveConfig::validate`.

use engine::cards;
use engine::cfr::{DcfrParams, Solver};
use engine::config::{NodeLock, Sizings, SolveConfig};
use engine::game::{Game, NodeInfo};
use engine::nlhe::NlheGame;

/// POLARIZED RIVER. Ks 7d 2c 8h 3d, 10 in the middle, 50 behind, one pot-size bet each
/// and no raises.
///
/// OOP holds 3 combos of trip kings (the nuts here) and 8 combos of ace-high (which beat
/// nothing IP has); IP holds 12 combos of TT/JJ, every one of them a bluffcatcher that
/// beats the ace-high and loses to the trips. That is the textbook shape: OOP's
/// equilibrium bets the trips and bluffs some of the ace-high, and IP calls often enough
/// to keep the bluffs honest.
///
/// The tree is 4 decision nodes on one board, so a lock can name any of them with a
/// two-token line and every node shares one combo axis.
fn river_cfg() -> SolveConfig {
    let mut cfg = SolveConfig {
        board: "Ks 7d 2c 8h 3d".to_string(),
        oop_range: "KK,A4s,A5s".to_string(),
        ip_range: "TT,JJ".to_string(),
        effective_stack: 50.0,
        starting_pot: 10.0,
        raise_cap: 0,
        ..SolveConfig::default()
    };
    cfg.sizings.oop.river.bet = Sizings::new(&[100.0], false);
    cfg.sizings.ip.river.bet = Sizings::new(&[100.0], false);
    cfg
}

/// The milestone-4 small flop spot: a real multi-street tree with 395 chance nodes, which
/// is what makes the determinism gate mean something.
#[cfg_attr(not(feature = "parallel"), allow(dead_code))]
fn small_flop_cfg() -> SolveConfig {
    let mut cfg = SolveConfig {
        board: "Qs Jh 2h".to_string(),
        oop_range: "88+,AJs+,KQs,AQo+".to_string(),
        ip_range: "99+,AJs+,AQo+".to_string(),
        effective_stack: 40.0,
        starting_pot: 6.0,
        raise_cap: 0,
        ..SolveConfig::default()
    };
    for p in [0u8, 1] {
        let s = if p == 0 { &mut cfg.sizings.oop } else { &mut cfg.sizings.ip };
        s.flop.bet = Sizings::new(&[50.0], false);
        s.turn.bet = Sizings::new(&[75.0], false);
        s.river.bet = Sizings::new(&[75.0], false);
    }
    cfg
}

fn solve(cfg: &SolveConfig, iters: u64) -> Solver<NlheGame> {
    let game = NlheGame::new(cfg).expect("game builds");
    let mut s = Solver::new(game);
    s.run(iters, &DcfrParams::from_config(cfg), 0, |_, _, _| {});
    s
}

fn decision_nodes(g: &NlheGame) -> Vec<u32> {
    (0..g.num_nodes() as u32)
        .filter(|&n| matches!(g.node(n), NodeInfo::Decision { .. }))
        .collect()
}

/// Mean probability of action `action` over every combo at decision node `node`.
fn mean_freq(s: &Solver<NlheGame>, node: u32, action: usize) -> f32 {
    let NodeInfo::Decision { player, .. } = s.game().node(node) else {
        panic!("node {node} is not a decision node");
    };
    let n = s.game().combo_count(node, player);
    let strategy = s.average_strategy(node);
    strategy[action * n..(action + 1) * n].iter().sum::<f32>() / n as f32
}

/// GATE 1. Freeze OOP to a pure-value betting range and IP must stop calling and start
/// winning.
///
/// The lock is per combo, not a flat frequency: trips bet, everything else checks. That
/// exercises the `strategy` form of a lock and is the shape a UI would send after a user
/// paints a range.
///
/// Both claims are directional with a margin, never exact values. The *reason* they must
/// hold is not statistical:
///
/// * IP's calls exist only to beat bluffs. Against a betting range that contains none,
///   calling with a hand that loses to every combo in it is strictly worse than folding,
///   so the call frequency collapses.
/// * Never bluffing is not OOP's equilibrium strategy (the spot has 3 nut combos and 8
///   ace-high, so the equilibrium bluffs). A player forced off their equilibrium in a
///   zero-sum game cannot do better, so the other player cannot do worse — and since the
///   lock is strictly worse for OOP, IP's value strictly rises.
#[test]
fn locking_oop_to_never_bluff_moves_ip_the_predicted_way() {
    let cfg = river_cfg();
    const ITERS: u64 = 3_000;

    let free = solve(&cfg, ITERS);
    let game = free.game();
    let tree = game.tree();
    let root = tree.resolve_line("").expect("root");
    let facing_bet = tree.resolve_line("bet:10").expect("IP faces the bet");
    assert_eq!(game.node(root), NodeInfo::Decision { player: 0, num_actions: 2 });
    assert_eq!(game.node(facing_bet), NodeInfo::Decision { player: 1, num_actions: 2 });

    // Action 1 at the root is the bet; action 1 facing it is the call.
    let combos = game.live_combos(root, 0).to_vec();
    let trips: Vec<bool> = combos
        .iter()
        .map(|&(a, b)| cards::rank(a) == cards::rank(b) && cards::rank(a) == 11)
        .collect();
    let n = combos.len();
    println!(
        "spot: OOP {n} combos ({} trip kings, {} ace-high), IP {} bluffcatchers",
        trips.iter().filter(|t| **t).count(),
        trips.iter().filter(|t| !**t).count(),
        game.combo_count(root, 1),
    );
    assert_eq!(trips.iter().filter(|t| **t).count(), 3, "3 combos of KK survive the Ks");

    // check = 1 for the ace-high, bet = 1 for the trips. Action-major.
    let mut pure_value = vec![0.0f64; 2 * n];
    for (i, &is_trips) in trips.iter().enumerate() {
        pure_value[i] = if is_trips { 0.0 } else { 1.0 };
        pure_value[n + i] = if is_trips { 1.0 } else { 0.0 };
    }
    let locked_cfg = SolveConfig {
        locks: vec![NodeLock {
            line: String::new(),
            player: 0,
            freqs: None,
            strategy: Some(pure_value.clone()),
        }],
        ..cfg.clone()
    };
    let locked = solve(&locked_cfg, ITERS);

    // The lock is reported back exactly, not as an average that merely resembles it.
    let want: Vec<f32> = pure_value.iter().map(|&x| x as f32).collect();
    assert_eq!(locked.average_strategy(root), want, "a locked node reports its lock verbatim");

    let (free_call, locked_call) = (mean_freq(&free, facing_bet, 1), mean_freq(&locked, facing_bet, 1));
    let (free_bluff, locked_bluff) = (mean_freq(&free, root, 1), mean_freq(&locked, root, 1));
    let (free_ev, locked_ev) = (free.expected_value(1), locked.expected_value(1));
    println!(
        "MEASURED after {ITERS} iters:\n  \
         OOP bet frequency   free {free_bluff:.4}  locked {locked_bluff:.4}\n  \
         IP  call frequency  free {free_call:.4}  locked {locked_call:.4}\n  \
         IP  EV (zero-sum)   free {free_ev:.4}  locked {locked_ev:.4}  (+{:.4} chips)\n  \
         exploitability      free {:.6}  locked {:.6} chips",
        locked_ev - free_ev,
        free.exploitability().chips,
        locked.exploitability().chips,
    );

    // The unlocked equilibrium really is the polarized one this reasoning assumes.
    assert!(
        free_bluff > 3.0 / n as f32 + 0.02,
        "the unlocked equilibrium must bluff for this test to mean anything, but OOP bets \
         only {free_bluff:.4} of its range and the trips alone are {:.4}",
        3.0 / n as f32
    );

    assert!(
        locked_call < free_call - 0.2,
        "IP must call far less against a range that never bluffs: {locked_call:.4} vs \
         {free_call:.4}"
    );
    assert!(locked_call < 0.05, "IP should barely call at all: {locked_call:.4}");
    assert!(
        locked_ev > free_ev + 0.1,
        "IP must gain from the lock: {locked_ev:.4} vs {free_ev:.4}"
    );
    // Both runs are still converged solutions of their own game.
    for (tag, s) in [("free", &free), ("locked", &locked)] {
        let e = s.exploitability();
        assert!(e.pct_of_pot < 0.5, "{tag} run is {:.4}% exploitable", e.pct_of_pot);
        let sum = s.expected_value(0) + s.expected_value(1);
        assert!(sum.abs() < 1e-3, "{tag} run is not zero-sum: {sum}");
    }
}

/// Every decision node of a config, locked to `s`'s current average strategy there.
fn lock_everything(cfg: &SolveConfig, s: &Solver<NlheGame>, lines: &[(&str, u8)]) -> SolveConfig {
    SolveConfig {
        locks: lines
            .iter()
            .map(|&(line, player)| {
                let node = s.game().tree().resolve_line(line).expect("line resolves");
                NodeLock {
                    line: line.to_string(),
                    player,
                    freqs: None,
                    strategy: Some(
                        s.average_strategy(node).iter().map(|&x| x as f64).collect(),
                    ),
                }
            })
            .collect(),
        ..cfg.clone()
    }
}

/// GATE 2, and the sharpest one: with every node locked there is nothing left to solve,
/// so the answer must be the profile that was locked in — **bit for bit**.
///
/// Both runs end up computing `br::expected_value` over the same strategy at every node,
/// so any discrepancy is the lock plumbing corrupting a strategy, not float noise. It also
/// pins the best-response side: with both players frozen everywhere, neither can deviate,
/// so each player's "best response" is their own value and exploitability is exactly the
/// zero-sum residual.
#[test]
fn a_lock_on_every_node_reproduces_the_profile_exactly() {
    let cfg = river_cfg();
    let free = solve(&cfg, 2_000);
    // The whole tree: OOP's lead, IP facing it, IP after a check, OOP facing that bet.
    let lines: [(&str, u8); 4] =
        [("", 0), ("bet:10", 1), ("check", 1), ("check,bet:10", 0)];
    let locked_cfg = lock_everything(&cfg, &free, &lines);
    assert_eq!(decision_nodes(free.game()).len(), lines.len(), "every node is covered");

    // One iteration is enough — and is itself part of the claim: with nothing free to
    // update, iterating cannot move anything.
    let locked = solve(&locked_cfg, 1);
    for &n in &decision_nodes(free.game()) {
        assert_eq!(
            locked.average_strategy(n),
            free.average_strategy(n),
            "node {n} does not report the strategy it was locked to"
        );
    }
    for p in 0..2u8 {
        let (a, b) = (free.expected_value(p), locked.expected_value(p));
        println!("fully locked: player {p} EV free {a:.9} locked {b:.9}  bits {:#010x} vs {:#010x}", a.to_bits(), b.to_bits());
        assert_eq!(a.to_bits(), b.to_bits(), "player {p} EV is not bit-identical");
    }
    // Neither player may deviate anywhere, so best response == own value and the two
    // cancel to the zero-sum residual.
    let e = locked.exploitability();
    let residual = locked.expected_value(0) + locked.expected_value(1);
    println!("fully locked: exploitability {:.9} chips, zero-sum residual {residual:.9}", e.chips);
    assert_eq!(e.chips.to_bits(), residual.to_bits(), "a fully locked profile cannot be exploited");
    assert!(e.chips.abs() < 1e-4, "rake-free residual should be ~0, got {}", e.chips);
}

/// GATE 3. Locking one node to the strategy it already converged to must not move the
/// solution — a lock that says "keep doing what you were doing" is a no-op.
///
/// The tolerance is derived, not invented: the unlocked run is only converged to within
/// its own exploitability, so the locked node is only *approximately* an equilibrium
/// strategy, and the re-solve can land that far away. The gate is 20x that residual,
/// which still fails loudly on a lock that shifts the solution.
#[test]
fn a_no_op_lock_reproduces_the_unlocked_solution() {
    let cfg = river_cfg();
    const ITERS: u64 = 3_000;
    let free = solve(&cfg, ITERS);
    let residual = free.exploitability().chips;

    // Lock only IP's node facing the bet; OOP and IP's check-line nodes stay free.
    let locked_cfg = lock_everything(&cfg, &free, &[("bet:10", 1)]);
    let locked = solve(&locked_cfg, ITERS);

    let tol = (20.0 * residual).max(1e-3);
    println!(
        "no-op lock: unlocked exploitability {residual:.6} chips -> tolerance {tol:.6}\n  \
         EV(OOP) free {:.6} locked {:.6}\n  EV(IP)  free {:.6} locked {:.6}\n  \
         exploitability free {:.6} locked {:.6}",
        free.expected_value(0),
        locked.expected_value(0),
        free.expected_value(1),
        locked.expected_value(1),
        residual,
        locked.exploitability().chips,
    );
    for p in 0..2u8 {
        let d = (free.expected_value(p) - locked.expected_value(p)).abs();
        assert!(d <= tol, "player {p} EV moved {d:.6} chips, tolerance {tol:.6}");
    }
    assert!(
        locked.exploitability().chips <= tol,
        "locking a node to its own equilibrium strategy should stay converged, but \
         exploitability is {:.6}",
        locked.exploitability().chips
    );
}

/// Bit-exact fingerprint of every average strategy, as in the milestone-4 gate.
#[cfg_attr(not(feature = "parallel"), allow(dead_code))]
fn strategy_fingerprint(s: &Solver<NlheGame>) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for n in decision_nodes(s.game()) {
        for v in s.average_strategy(n) {
            h ^= v.to_bits() as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

/// GATE 4. A locked solve is still bit-identical for every thread count.
///
/// The lock table is read-only shared state and the parallel fork is unchanged, so this
/// should be free — but "should be free" is exactly the claim a determinism test exists to
/// stop anyone from asserting without measuring. Run on a real flop tree so the rayon fork
/// at the turn chance node is actually taken.
#[cfg(feature = "parallel")]
#[test]
fn a_locked_solve_is_thread_count_independent() {
    use std::time::Instant;

    let mut cfg = small_flop_cfg();
    cfg.locks = vec![NodeLock {
        // OOP's flop node: a flat 50/50 check-bet for every combo.
        line: String::new(),
        player: 0,
        freqs: Some(vec![0.5, 0.5]),
        strategy: None,
    }];
    const ITERS: u64 = 20;

    let mut baseline: Option<(f32, f32, u64)> = None;
    for threads in [1usize, 3, 8] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("rayon pool builds");
        let t0 = Instant::now();
        let got = pool.install(|| {
            assert_eq!(rayon::current_num_threads(), threads);
            let s = solve(&cfg, ITERS);
            // The lock survives the parallel traversal untouched.
            assert_eq!(s.average_strategy(0), vec![0.5f32; s.average_strategy(0).len()]);
            (s.exploitability().chips, s.expected_value(0), strategy_fingerprint(&s))
        });
        println!(
            "locked determinism: {threads:>2} thread(s), {ITERS} iters in {:>9.3?}  \
             exploitability {:.9}  EV(OOP) {:.9}  fingerprint {:#018x}",
            t0.elapsed(),
            got.0,
            got.1,
            got.2
        );
        match baseline {
            None => baseline = Some(got),
            Some(want) => assert_eq!(
                got, want,
                "a locked solve differs at {threads} threads: {got:?} vs {want:?}"
            ),
        }
    }
}

/// A lock is only meaningful against a built tree, so this is where a bad line, the wrong
/// player, a bad arity or an unnormalized row has to be caught — before a solve is paid
/// for, and with a message that names the offending entry.
#[test]
fn malformed_locks_are_rejected_when_the_game_is_built() {
    let cfg = river_cfg();
    let good = NodeLock {
        line: "bet:10".to_string(),
        player: 1,
        freqs: Some(vec![0.5, 0.5]),
        strategy: None,
    };
    NlheGame::new(&SolveConfig { locks: vec![good.clone()], ..cfg.clone() })
        .expect("a well formed lock builds");

    let cases: [(NodeLock, &str); 8] = [
        // Bad line: a step that is not an action, an amount the node does not offer, and
        // a line that runs off the end of the hand.
        (NodeLock { line: "shove".into(), ..good.clone() }, "unknown action"),
        (NodeLock { line: "bet:7".into(), ..good.clone() }, "is not offered"),
        (NodeLock { line: "bet:10,call,check".into(), ..good.clone() }, "past the end"),
        // Right node, wrong player.
        (NodeLock { player: 0, ..good.clone() }, "where player 1 acts, not player 0"),
        // Bad arity, both forms.
        (NodeLock { freqs: Some(vec![1.0]), ..good.clone() }, "offers 2 actions"),
        (
            NodeLock { freqs: None, strategy: Some(vec![1.0, 0.0]), ..good.clone() },
            "2 actions * 12 combos = 24",
        ),
        // Rows that are not distributions.
        (NodeLock { freqs: Some(vec![0.5, 0.4]), ..good.clone() }, "sum to 0.9"),
        (
            NodeLock { freqs: None, strategy: Some(vec![0.25; 24]), ..good.clone() },
            "sum to 0.5, not 1",
        ),
    ];
    for (lock, needle) in cases {
        let err = NlheGame::new(&SolveConfig { locks: vec![lock.clone()], ..cfg.clone() })
            .expect_err(&format!("expected {needle:?} for {lock:?}"));
        println!("rejected: {err}");
        assert!(err.contains(needle), "wanted {needle:?}, got {err}");
        assert!(err.starts_with("locks[0]"), "error must name the entry: {err}");
    }

    // Two locks on the same node are ambiguous, whichever way round they are written.
    let err = NlheGame::new(&SolveConfig {
        locks: vec![good.clone(), good.clone()],
        ..cfg.clone()
    })
    .expect_err("a doubly locked node must be rejected");
    assert!(err.contains("already locked"), "{err}");
}
