//! FINGERPRINT LOCK — the cross-commit bit-identity gate.
//!
//! Every other determinism test in this repo compares a run to another run *of the same
//! binary*: `milestone3_is_bit_identical_across_identical_solves` (`nlhe.rs`),
//! `akq_is_deterministic` (`games/akq.rs`) and the thread-count gate in `milestone4.rs`
//! all re-solve and compare. None of them notices when a code change moves every solve
//! in the repo by the same amount, which is exactly what a payoff-path edit does.
//!
//! This file closes that gap by hard-coding the answers. Five configurations are solved
//! and pinned to constants harvested on today's main:
//!
//! | # | solve                          | pins                                      |
//! |---|--------------------------------|-------------------------------------------|
//! | 1 | Kuhn poker, 10k iters          | strategy fingerprint, EV(0), EV(1), expl. |
//! | 2 | AKQ, three bet sizes, 1k iters | same, once per variant                    |
//! | 3 | milestone-3 river spot, 20k    | same                                      |
//! | 4 | milestone-4 small flop, f32    | same                                      |
//! | 5 | milestone-4 small flop, i16    | same                                      |
//!
//! The strategy fingerprint folds raw `f32` bit patterns of every average strategy at
//! every decision node; the three scalars are pinned as exact `f32` bit patterns
//! (`to_bits`), never as an epsilon comparison. There is no tolerance anywhere in this
//! file and there must never be one: the whole point is that a chipEV solve on tomorrow's
//! main is the same solve, bit for bit, as on the commit that wrote these numbers.
//!
//! Run it both ways — the parallel fork must not change a bit:
//!
//! ```text
//! cargo test -p engine --release --test fingerprint -- --nocapture
//! cargo test -p engine --release --no-default-features --test fingerprint -- --nocapture
//! ```
//!
//! If a *platform* (not a code change) disagrees, commit a per-target constant table.
//! Never weaken this to an epsilon.

use std::time::Instant;

use engine::cfr::{DcfrParams, Solver, StorageMode};
use engine::config::{SolveConfig, Sizings};
use engine::game::{Game, NodeInfo};
use engine::games::akq::Akq;
use engine::games::kuhn::Kuhn;
use engine::nlhe::NlheGame;

// =====================================================================
// The fingerprint itself
// =====================================================================

/// Bit-exact fingerprint of every average strategy in the solve.
///
/// Copied verbatim from `milestone4.rs:256` (generic over the game so it can also
/// fingerprint Kuhn and AKQ) and deliberately NOT lifted into the library: this gate has
/// to keep measuring what it measured on the day the constants were harvested, so it owns
/// its own copy and a refactor of the library cannot silently redefine it.
///
/// Folds the raw `f32` bit patterns, so two fingerprints match only if every probability
/// at every decision node is bit-identical — no epsilon anywhere.
fn strategy_fingerprint<G: Game>(s: &Solver<G>) -> u64 {
    let g = s.game();
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for n in 0..g.num_nodes() as u32 {
        if matches!(g.node(n), NodeInfo::Decision { .. }) {
            for v in s.average_strategy(n) {
                h ^= v.to_bits() as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    h
}

/// What one solve is pinned to. Scalars are exact `f32` bit patterns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pin {
    fp: u64,
    ev0: u32,
    ev1: u32,
    expl: u32,
}

/// Solve volume, printed beside every assertion so a gate that checked nothing is
/// distinguishable from a gate that passed.
struct Volume {
    nodes: usize,
    decisions: usize,
    terminals: usize,
    iters: u64,
    combos: (usize, usize),
    entries: usize,
}

fn volume<G: Game>(g: &G, iters: u64) -> Volume {
    let (mut decisions, mut terminals, mut entries) = (0, 0, 0);
    for n in 0..g.num_nodes() as u32 {
        match g.node(n) {
            NodeInfo::Decision { player, num_actions } => {
                decisions += 1;
                entries += num_actions * g.combo_count(n, player);
            }
            NodeInfo::Terminal => terminals += 1,
            NodeInfo::Chance { .. } => {}
        }
    }
    let root = g.root();
    Volume {
        nodes: g.num_nodes(),
        decisions,
        terminals,
        iters,
        combos: (g.combo_count(root, 0), g.combo_count(root, 1)),
        entries,
    }
}

/// Measure one finished solve, print its volume and its numbers, and pin all four.
fn check<G: Game>(name: &str, s: &Solver<G>, iters: u64, want: Pin, wall: std::time::Duration) {
    let v = volume(s.game(), iters);
    let e = s.exploitability();
    let (ev0, ev1) = (s.expected_value(0), s.expected_value(1));
    let got = Pin { fp: strategy_fingerprint(s), ev0: ev0.to_bits(), ev1: ev1.to_bits(), expl: e.chips.to_bits() };

    println!(
        "{name}: VOLUME {} nodes ({} decision, {} terminal), {} strategy entries, \
         root combos {}v{}, {} iterations, {wall:.3?}",
        v.nodes, v.decisions, v.terminals, v.entries, v.combos.0, v.combos.1, v.iters,
    );
    println!(
        "{name}: fp {:#018x}  EV0 {ev0:.9} ({:#010x})  EV1 {ev1:.9} ({:#010x})  \
         expl {:.9} ({:#010x})",
        got.fp, got.ev0, got.ev1, e.chips, got.expl,
    );
    println!(
        "{name}: PIN Pin {{ fp: {:#018x}, ev0: {:#010x}, ev1: {:#010x}, expl: {:#010x} }}",
        got.fp, got.ev0, got.ev1, got.expl,
    );

    assert_eq!(got.fp, want.fp, "{name}: average strategies moved");
    assert_eq!(got.ev0, want.ev0, "{name}: EV(0) moved: {ev0:.9} vs {:.9}", f32::from_bits(want.ev0));
    assert_eq!(got.ev1, want.ev1, "{name}: EV(1) moved: {ev1:.9} vs {:.9}", f32::from_bits(want.ev1));
    assert_eq!(
        got.expl, want.expl,
        "{name}: exploitability moved: {:.9} vs {:.9}",
        e.chips,
        f32::from_bits(want.expl)
    );
}

// =====================================================================
// The five configurations
// =====================================================================

const KUHN_ITERS: u64 = 10_000;
const AKQ_ITERS: u64 = 1_000;
const M3_ITERS: u64 = 20_000;
const FLOP_ITERS: u64 = 200;

/// MILESTONE-3 SPOT, reconstructed here because `nlhe.rs`'s copy lives in a private
/// `#[cfg(test)]` module. Ks 7d 2c 8h 3d river, 10 in the middle and 10 behind, one
/// pot-size bet per player, no raises: KK vs air against TT/JJ bluffcatchers.
fn milestone3_cfg() -> SolveConfig {
    let mut cfg = SolveConfig {
        board: "Ks 7d 2c 8h 3d".to_string(),
        oop_range: "KK,A4s,A5s".to_string(),
        ip_range: "TT,JJ".to_string(),
        effective_stack: 10.0,
        starting_pot: 10.0,
        raise_cap: 0,
        ..SolveConfig::default()
    };
    cfg.sizings.oop.river.bet = Sizings::new(&[100.0], false);
    cfg.sizings.ip.river.bet = Sizings::new(&[100.0], false);
    cfg
}

/// MILESTONE-4 SMALL FLOP, reconstructed from `milestone4.rs:76 small_flop_cfg`.
/// Qs Jh 2h, tight ranges, one bet size per street, no raises, 40 behind — a real
/// multi-street chance tree (395 chance nodes, 1226 boards) at a size a plain test run
/// can afford.
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

fn solve_nlhe(cfg: &SolveConfig, iters: u64, mode: StorageMode) -> (Solver<NlheGame>, std::time::Duration) {
    let game = NlheGame::new(cfg).expect("game builds");
    let mut s = Solver::new_with_storage(game, mode);
    let t0 = Instant::now();
    s.run(iters, &DcfrParams::from_config(cfg), 0, |_, _, _| {});
    (s, t0.elapsed())
}

// ---------------------------------------------------------------------
// PINNED CONSTANTS — harvested on main at 4899313, x86_64-pc-windows-msvc,
// identical with and without `--features parallel`.
//
// A failure here is not a flaky test. It means a change altered a chipEV solve.
// ---------------------------------------------------------------------

const KUHN: Pin = Pin { fp: 0xc78f2294800dddc1, ev0: 0xbd638e2b, ev1: 0x3d638e35, expl: 0x38272800 };
// AKQ at B = P is the boundary variant: the Nash set is a segment, the game value is
// exactly 0 to both players and DCFR lands on 0.0 exploitability. Those three zeros are
// MEASURED, not an unfilled placeholder — the `fp` beside them is what pins this solve.
const AKQ_P1_B1: Pin = Pin { fp: 0xe666997eb4d8bae2, ev0: 0x00000000, ev1: 0x00000000, expl: 0x00000000 };
const AKQ_P1_BHALF: Pin = Pin { fp: 0x9d0d05376377328f, ev0: 0xbce38e35, ev1: 0x3ce38e30, expl: 0x389a0000 };
const AKQ_P1_BQUARTER: Pin = Pin { fp: 0x41d5c88652b86a66, ev0: 0xbccccccb, ev1: 0x3cccccd5, expl: 0x37fe0000 };
const M3_RIVER: Pin = Pin { fp: 0xcdd41e9fac7d1bec, ev0: 0xbf68ba3a, ev1: 0x3f68ba30, expl: 0x3939b000 };
const FLOP_F32: Pin = Pin { fp: 0xdeb7fd91ea463544, ev0: 0xbf20ab08, ev1: 0x3f20ab08, expl: 0x3c0f8880 };
const FLOP_I16: Pin = Pin { fp: 0x6e0d76ee1bd2d92d, ev0: 0xbf20be18, ev1: 0x3f20be18, expl: 0x3c2a3d80 };

// =====================================================================
// The gates
// =====================================================================

#[test]
fn fingerprint_1_kuhn() {
    let mut s = Solver::new(Kuhn::new());
    let t0 = Instant::now();
    s.run(KUHN_ITERS, &DcfrParams::default(), 0, |_, _, _| {});
    check("kuhn", &s, KUHN_ITERS, KUHN, t0.elapsed());
}

#[test]
fn fingerprint_2_akq_all_three_variants() {
    for (pot, bet, want, tag) in [
        (1.0, 1.0, AKQ_P1_B1, "akq P1 B1"),
        (1.0, 0.5, AKQ_P1_BHALF, "akq P1 B0.5"),
        (1.0, 0.25, AKQ_P1_BQUARTER, "akq P1 B0.25"),
    ] {
        let mut s = Solver::new(Akq::new(pot, bet));
        let t0 = Instant::now();
        s.run(AKQ_ITERS, &DcfrParams::default(), 0, |_, _, _| {});
        check(tag, &s, AKQ_ITERS, want, t0.elapsed());
    }
}

#[test]
fn fingerprint_3_milestone3_river() {
    let (s, wall) = solve_nlhe(&milestone3_cfg(), M3_ITERS, StorageMode::F32);
    assert_eq!(s.game().num_boards(), 1, "a river tree deals no cards");
    check("m3 river", &s, M3_ITERS, M3_RIVER, wall);
}

#[test]
fn fingerprint_4_small_flop_f32() {
    let (s, wall) = solve_nlhe(&small_flop_cfg(), FLOP_ITERS, StorageMode::F32);
    assert_eq!(s.game().num_boards(), 1 + 49 + 49 * 48 / 2, "every runout board is built");
    check("small flop f32", &s, FLOP_ITERS, FLOP_F32, wall);
}

#[test]
fn fingerprint_5_small_flop_i16() {
    let (s, wall) = solve_nlhe(&small_flop_cfg(), FLOP_ITERS, StorageMode::I16);
    assert_eq!(s.game().num_boards(), 1 + 49 + 49 * 48 / 2, "every runout board is built");
    check("small flop i16", &s, FLOP_ITERS, FLOP_I16, wall);
    assert_ne!(
        FLOP_I16, FLOP_F32,
        "the i16 codec must not be pinned to the same numbers as f32; one of the two \
         constants was copied from the other"
    );
}
