# solver

A heads-up no-limit hold'em postflop GTO solver, targeting PioSOLVER-level
correctness. Two crates:

- `engine/` — the solving library: card/range/tree primitives, a vector-form
  Discounted CFR implementation (`cfr::Solver`), a full best-response /
  exploitability calculator (`br`), the concrete NLHE game (`nlhe::NlheGame`),
  and the solution file format (`solution::Solution`).
- `cli/` — a binary crate, `solver`, with two subcommands: `solve` (run a
  solve, optionally save it) and `show` (inspect a saved solution without
  re-solving).

## Workspace layout

```
engine/src/
  cards.rs      card primitives (rank/suit, parsing)
  config.rs     SolveConfig: the TOML spec for one solve
  range.rs      1326-combo range parsing and canonical ordering
  evaluator.rs  7-card hand evaluation
  tree.rs       GameTree: the public betting/chance tree
  iso.rs        canonical flop isomorphism (1755 distinct flops)
  terminal.rs   showdown/fold payoff tables
  game.rs       the abstract Game trait the CFR core runs on
  cfr.rs        Solver<G>: alternating Discounted CFR
  br.rs         best-response value and exploitability
  nlhe.rs       NlheGame: Game impl over a GameTree + two ranges
  solution.rs   Solution: the persisted solve output (this milestone)
  games/        toy games (Kuhn, AKQ) used to validate the CFR core
cli/src/
  main.rs       subcommand dispatch
  solve.rs      `solver solve`
  show.rs       `solver show`
cli/tests/
  cli.rs        real-binary integration test (spawns the built `solver` exe)
  fixtures/     tiny TOML configs for that test
```

## Build

```
cargo build --release
```

## Solve a spot

`solve` reads a base TOML config and applies any CLI overrides, builds the
tree, runs Discounted CFR in `--report-every`-sized chunks, and stops at
`target_exploitability` or `max_iterations`, whichever comes first.

Sample config (`cli/tests/fixtures/river.toml`):

```toml
board = "Ks 7d 2c 8h 3d"
oop_range = "KK,A4s,A5s"
ip_range = "TT,JJ"
effective_stack = 20.0
starting_pot = 10.0
raise_cap = 1
max_iterations = 200
target_exploitability = 0.01

[sizings.oop.river]
bet = { percents = [100.0] }

[sizings.ip.river]
bet = { percents = [100.0] }
raise = { percents = [100.0] }
```

```
cargo run --release -p solver-cli -- solve \
  --config cli/tests/fixtures/river.toml \
  --report-every 50 \
  --out solution.json
```

Overrides available on the command line: `--board`, `--oop-range`,
`--ip-range`, `--stack`, `--pot`, `--max-iterations`,
`--target-exploitability`, `--report-every` (default 100), `--threads`
(rayon pool size; default all logical CPUs), `--out`.

If `turn_chance_sampling` is set in the config, `solve` refuses to run rather
than silently approximating: exact search (full enumeration) is the only
solve mode implemented so far. The flag exists in `SolveConfig` for a future
sampling-based speed mode.

Every exploitability and EV figure `solve` prints is tagged `[measured]` —
it comes straight out of `br::exploitability` against the current average
strategy, never an estimate.

**`--threads`**: the CFR traversal parallelizes across chance-node outcomes
with rayon (parallel map, sequential reduce), so solved strategies and
exploitability are bit-identical for every thread count. Measured on the
milestone-4 flop spot (830k nodes, 24 logical CPUs): 2524 ms/iter at 1
thread, 370 ms/iter at 24 (6.8×).

## Inspect a saved solution

`show` loads a `Solution` file (which internally rebuilds the tree from the
embedded config and checks node count / per-node action counts against what
the file claims, failing loudly on any mismatch) and never re-solves.

```
cargo run --release -p solver-cli -- show --solution solution.json \
  --line "check,bet:100"

cargo run --release -p solver-cli -- show --solution solution.json \
  --line "check,bet:100" --combo KcKd
```

`--line` is a comma-separated action path from the root: `fold`/`check`/
`call`/`allin` match literally, `bet:PCT`/`raise:PCT` match the sizing whose
percent-of-pot rounds to `PCT` (raise percent is computed against the pot as
it would be after calling, matching `SolveConfig`'s own raise-sizing
formula). Omit `--line` to show the root node.

With no `--combo`, `show` prints a 13x13 rank grid: each cell is the live
combos in that bucket's dominant action and its frequency, averaged uniformly
per combo (weight 1 each — the same convention the engine's own tests use).
With `--combo AhKh`, it prints that exact combo's full action distribution
instead.

## Tests

```
cargo test -p engine --release --lib
cargo test -p solver-cli --release
```

`--lib` on the engine test run is required right now: `engine/examples/` has
an untracked, currently-broken example file (unrelated to this milestone —
not owned or touched here) that `cargo test` otherwise tries to build as part
of the default target set. `-p engine --release --lib` restricts the run to
the library's own unit tests and skips it.

`cli`'s test is a real-binary integration test: it spawns the actual built
`solver` executable via `std::process::Command` (using
`CARGO_BIN_EXE_solver`), running `solve` then `show` against
`cli/tests/fixtures/river.toml`, and asserts on real exit codes and stdout —
not in-process function calls.

## Status

- **Milestones 1-3: passed and committed.** Kuhn poker (0.002% of pot
  exploitability), AKQ (closed-form match), and a hand-verified NLHE river
  spot (0.0018% of pot, indifference verified by hand) — see
  `engine/src/games/` and the `nlhe` module's milestone-3 test for the
  worked math.
- **This milestone (solution file format + CLI): done.** `solution.rs`
  round-trips a solved strategy through JSON and rejects a tampered file;
  the `solver` binary solves and inspects spots end to end.
- **Not started yet:** milestone 4 proper (whatever it turns out to cover)
  and the WASM/web UI. `Solution` is deliberately designed as the product
  contract those will read.

No performance claims beyond what's been directly measured on this machine
appear anywhere in this repo. Everything printed by `solve` and `show` is
computed from a real run, not estimated.
