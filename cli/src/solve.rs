//! `solver solve`: build a spot, run Discounted CFR to a stopping condition, report,
//! and optionally save a [`Solution`].

use std::path::PathBuf;
use std::time::Instant;

use clap::Args;
use engine::cfr::{DcfrParams, Solver};
use engine::config::SolveConfig;
use engine::nlhe::NlheGame;
use engine::solution::Solution;
use engine::tree::NodeKind;

#[derive(Args)]
pub struct SolveArgs {
    /// Path to the base TOML config.
    #[arg(long)]
    config: PathBuf,

    /// Override: board cards, e.g. "As Kd 7h".
    #[arg(long)]
    board: Option<String>,
    /// Override: OOP range string.
    #[arg(long = "oop-range")]
    oop_range: Option<String>,
    /// Override: IP range string.
    #[arg(long = "ip-range")]
    ip_range: Option<String>,
    /// Override: effective stack, in chips.
    #[arg(long)]
    stack: Option<f64>,
    /// Override: starting pot, in chips.
    #[arg(long)]
    pot: Option<f64>,
    /// Override: hard iteration ceiling.
    #[arg(long = "max-iterations")]
    max_iterations: Option<u64>,
    /// Override: stop once exploitability falls below this percent of pot.
    #[arg(long = "target-exploitability")]
    target_exploitability: Option<f64>,
    /// Measure and print exploitability every N iterations; also the granularity
    /// of the stop-condition check.
    #[arg(long = "report-every", default_value_t = 100)]
    report_every: u64,
    /// Rayon global thread pool size (default: all logical CPUs). The CFR
    /// traversal parallelizes across chance-node outcomes; results are
    /// bit-identical for every thread count.
    #[arg(long)]
    threads: Option<usize>,
    /// Write the solved strategy here. Omit to solve-and-print only.
    #[arg(long)]
    out: Option<PathBuf>,
}

pub fn run(args: SolveArgs) -> Result<(), String> {
    if args.report_every == 0 {
        return Err("--report-every must be at least 1 (it drives the stop-condition check)".into());
    }

    let text = std::fs::read_to_string(&args.config)
        .map_err(|e| format!("cannot read {:?}: {e}", args.config))?;
    let mut cfg = SolveConfig::from_toml_str(&text)?;

    if let Some(b) = args.board {
        cfg.board = b;
    }
    if let Some(r) = args.oop_range {
        cfg.oop_range = r;
    }
    if let Some(r) = args.ip_range {
        cfg.ip_range = r;
    }
    if let Some(s) = args.stack {
        cfg.effective_stack = s;
    }
    if let Some(p) = args.pot {
        cfg.starting_pot = p;
    }
    if let Some(m) = args.max_iterations {
        cfg.max_iterations = m;
    }
    if let Some(t) = args.target_exploitability {
        cfg.target_exploitability = t;
    }
    cfg.validate()?;

    if cfg.turn_chance_sampling {
        return Err(
            "turn_chance_sampling is set, but exact search is the only mode implemented so far \
             (the flag exists for a future speed mode) - refusing to silently approximate"
                .to_string(),
        );
    }

    if let Some(n) = args.threads {
        if let Err(e) = rayon::ThreadPoolBuilder::new().num_threads(n).build_global() {
            eprintln!("warning: could not configure the rayon thread pool ({e}); continuing");
        }
    }

    let game = NlheGame::new(&cfg)?;
    print_tree_stats(&game);

    let params = DcfrParams::from_config(&cfg);
    let mut solver = Solver::new(game);

    let start = Instant::now();
    let mut done = 0u64;
    let mut last_pct = f32::INFINITY;
    while done < cfg.max_iterations {
        let chunk = args.report_every.min(cfg.max_iterations - done);
        solver.run(chunk, &params, chunk, |i, chips, pct| {
            println!("iter {i:>8}  exploitability {chips:.6} chips  {pct:.4}% of pot  [measured]");
            last_pct = pct;
        });
        done += chunk;
        if (last_pct as f64) <= cfg.target_exploitability {
            break;
        }
    }
    let wall_seconds = start.elapsed().as_secs_f64();

    print_final_report(&solver, wall_seconds);

    if let Some(out) = args.out {
        let sol = Solution::from_solver(&solver, wall_seconds);
        sol.save(&out)?;
        println!("wrote {}", out.display());
    }
    Ok(())
}

fn print_tree_stats(game: &NlheGame) {
    let counts = game.tree().counts();
    println!(
        "tree: {} decision, {} chance, {} fold, {} showdown terminals ({} nodes total)",
        counts.decision, counts.chance, counts.fold, counts.showdown, counts.total
    );
    println!(
        "strategy storage: {} bytes [measured]  (regret + strategy-sum arrays, f32)",
        strategy_storage_bytes(game)
    );
    println!("chance maps: {} bytes [measured]", game.chance_map_bytes());
}

/// Bytes the solver's regret + cumulative-strategy arrays hold: two `f32` arrays of
/// `num_actions * combo_count` per decision node — the same sizing `Solver::new`
/// does internally, recomputed here since the solver does not expose the totals.
fn strategy_storage_bytes(game: &NlheGame) -> usize {
    let tree = game.tree();
    let mut total = 0usize;
    for idx in 0..tree.len() as u32 {
        if let NodeKind::Decision { player, actions } = &tree.node(idx).kind {
            total += actions.len() * game.live_combos(idx, *player).len();
        }
    }
    total * 2 * std::mem::size_of::<f32>()
}

fn print_final_report(solver: &Solver<NlheGame>, wall_seconds: f64) {
    let game = solver.game();
    let report = solver.exploitability();
    println!("=== final report ===");
    println!("iterations: {}", solver.iterations());
    println!("wall time: {wall_seconds:.4} s [measured]");
    println!(
        "exploitability: {:.6} chips  {:.4}% of pot  [measured]",
        report.chips, report.pct_of_pot
    );
    for p in 0..2u8 {
        let who = if p == 0 { "OOP" } else { "IP " };
        let zero_sum = solver.expected_value(p);
        let pot_share = game.ev_pot_share(p, zero_sum);
        println!("{who} EV: zero-sum {zero_sum:.4}  pot-share {pot_share:.4}  [measured]");
    }
}
