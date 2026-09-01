//! `solver`: command-line front end for the postflop solving engine.

mod show;
mod solve;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "solver", version, about = "Heads-up NLHE postflop GTO solver")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Solve a spot with Discounted CFR and optionally save it.
    Solve(solve::SolveArgs),
    /// Inspect a saved solution without re-solving.
    Show(show::ShowArgs),
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Solve(args) => solve::run(args),
        Command::Show(args) => show::run(args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
