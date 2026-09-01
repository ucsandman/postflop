//! Solve a spot from a TOML config and report the convergence curve, wall time and peak
//! memory.
//!
//! ```text
//! cargo run -p engine --release --example solve_flop -- <config.toml> <iterations> [report_every]
//! ```
//!
//! `report_every` defaults to `iterations / 10`. Each report runs two full best-response
//! walks, which are sequential and not cheap on a flop tree, so the reported wall time
//! includes them — set `report_every` to `0` to time the iteration alone.

use std::time::Instant;

use engine::cfr::{DcfrParams, Solver};
use engine::config::SolveConfig;
use engine::game::{Game, NodeInfo};
use engine::nlhe::NlheGame;

/// Bytes of cumulative regret + cumulative strategy the solver allocates: two `f32`
/// arrays of `sum over decision nodes of num_actions * combo_count(node, acting)`.
fn storage_bytes(g: &NlheGame) -> usize {
    let mut entries = 0usize;
    for n in 0..g.num_nodes() as u32 {
        if let NodeInfo::Decision { player, num_actions } = g.node(n) {
            entries += num_actions * g.combo_count(n, player);
        }
    }
    entries * 4 * 2
}

/// Peak working set of this process, in bytes.
///
/// Read straight from `K32GetProcessMemoryInfo` (exported by `kernel32.dll` since
/// Windows 7, so it needs no crate and no extra link directive) into a hand-declared
/// `PROCESS_MEMORY_COUNTERS`. `PeakWorkingSetSize` is the high-water mark of resident
/// physical memory for the whole process — it therefore includes the binary, the
/// evaluator tables and every rayon worker's arena, not just the solver's own arrays.
#[cfg(windows)]
fn peak_working_set_bytes() -> Option<usize> {
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    let mut c = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        ..Default::default()
    };
    // SAFETY: `c` is a correctly sized, correctly laid out PROCESS_MEMORY_COUNTERS and
    // `cb` matches its size; the pseudo-handle from GetCurrentProcess is always valid.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (ok != 0).then_some(c.peak_working_set_size)
}

/// Peak RSS in kB from `/proc/self/status`, scaled to bytes.
#[cfg(not(windows))]
fn peak_working_set_bytes() -> Option<usize> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    Some(line.split_whitespace().nth(1)?.parse::<usize>().ok()? * 1024)
}

fn mb(bytes: usize) -> f64 {
    bytes as f64 / 1_048_576.0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path, iters] = &args[..2.min(args.len())] else {
        eprintln!("usage: solve_flop <config.toml> <iterations> [report_every]");
        std::process::exit(2);
    };
    let iters: u64 = iters.parse().expect("iterations must be a number");
    let report_every: u64 = args
        .get(2)
        .map(|s| s.parse().expect("report_every must be a number"))
        .unwrap_or((iters / 10).max(1));

    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let cfg = SolveConfig::from_toml_str(&text).expect("config parses");

    let t0 = Instant::now();
    let game = NlheGame::new(&cfg).expect("game builds");
    let build = t0.elapsed();

    let counts = game.tree().counts();
    println!("board {}  pot {}  stack {}", cfg.board, cfg.starting_pot, cfg.effective_stack);
    println!(
        "tree: {} nodes ({} decision, {} chance, {} fold, {} showdown), {} boards",
        counts.total,
        counts.decision,
        counts.chance,
        counts.fold,
        counts.showdown,
        game.num_boards()
    );
    println!(
        "combos at root: OOP {}, IP {}   build {:?}",
        game.combo_count(0, 0),
        game.combo_count(0, 1),
        build
    );
    let store = storage_bytes(&game);
    let maps = game.chance_map_bytes();
    println!(
        "memory: regret+strategy {} B ({:.1} MB), chance maps {} B ({:.1} MB)",
        store,
        mb(store),
        maps,
        mb(maps)
    );
    println!("threads: {}", rayon::current_num_threads());

    let mut solver = Solver::new(game);
    let t1 = Instant::now();
    solver.run(iters, &DcfrParams::from_config(&cfg), report_every, |i, chips, pct| {
        println!("iter {i:>7}  exploitability {chips:.9} chips  {pct:.6}% of pot");
    });
    let wall = t1.elapsed();

    let (v0, v1) = (solver.expected_value(0), solver.expected_value(1));
    let e = solver.exploitability();
    println!("---");
    println!("final exploitability {:.9} chips  {:.6}% of pot", e.chips, e.pct_of_pot);
    println!("EV: OOP {v0:.6}  IP {v1:.6}  sum {:.9}", v0 + v1);
    println!(
        "MEASURED wall time: {:?} for {} iterations ({:.1} ms/iter), \
         plus {} exploitability reports",
        wall,
        iters,
        wall.as_secs_f64() * 1000.0 / iters as f64,
        if report_every > 0 { iters / report_every } else { 0 }
    );
    match peak_working_set_bytes() {
        Some(b) => println!("MEASURED peak working set: {b} B ({:.1} MB)", mb(b)),
        None => println!("peak working set: unavailable"),
    }
}
