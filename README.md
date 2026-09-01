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
wasm/           the engine compiled to WebAssembly (see wasm/src/lib.rs)
web/            the browser UI (Next.js) — see "Web UI" below
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
(rayon pool size; default all logical CPUs), `--storage f32|i16` (i16 roughly
halves peak memory at the cost of a quantization floor on exploitability),
`--out`.

Config-only extras: `regret_floor = true` enables the CFR+-style floor at
zero on cumulative regrets (default off, plain DCFR discounting).

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

## Web UI

`web/` is a Next.js (App Router, TypeScript, Tailwind) front end for the same
engine, compiled to WebAssembly. It loads and inspects saved solutions, and can
run small solves in the browser.

### Run it

```
wasm-pack build wasm --target web --out-dir pkg
cd web
npm install
npm run dev            # http://localhost:3000
```

`npm run dev` and `npm run build` both run `scripts/sync-wasm.mjs` first, which
copies the wasm-pack output into `web/vendor/solver-wasm/` (glue + types, for
the bundler) and `web/public/wasm/` (glue + binary, served over HTTP for the
solve worker), and copies `fixture-turn.json` / `fixture-river.json` into
`web/public/fixtures/` for the sample buttons. All three directories are
generated and gitignored. If `wasm/pkg` is missing the script fails loudly with
the `wasm-pack` command to run.

### What it does

- **Load** a solution written by `solver solve`, or exported from the page.
  Loading rebuilds the tree structure and reads the stored strategies; it never
  re-solves. Bad files surface the engine's own error text.
- **Inspect.** A 13x13 grid for the acting player, each cell a stacked bar of
  action frequencies weighted by live combo reach; click a cell for the
  per-combo action distribution and per-hand EV. A tree navigator walks the
  action line, and chance nodes offer a 52-card runout selector with dead cards
  disabled. The opponent's reach-weighted range is shown alongside.
- **Solve.** A form builds the same TOML the CLI reads, runs `tree_stats` as a
  preflight (warning above ~300 MB predicted storage, hard confirm above 1 GB),
  then solves with a live exploitability curve. Results open in the inspector.
- **Export** the loaded or freshly solved solution back to JSON. That file
  reloads here and reads in the CLI.

### Threading

The browser build is **single-threaded**. `engine`'s rayon parallelism is behind
the default-on `parallel` feature; `solver-wasm` depends on the engine with
`default-features = false` because rayon cannot spawn threads on
`wasm32-unknown-unknown`. The CLI uses every core, the browser uses one. Solving
runs in a Web Worker (`web/public/solve-worker.js`) because `solve_spot` blocks
its thread for the whole run — that is what keeps the progress curve live rather
than arriving in one lump after the solve finishes.

Screenshots of the running UI: `web/docs/screens/`.

## Tests

```
cargo test --release --workspace
```

Two heavyweight verifications are `#[ignore]`d and run explicitly:

```
cargo test -p engine --release verify_1m -- --ignored --nocapture   # evaluator vs oracle, 1M hands
cargo test -p engine --release milestone4 -- --ignored --nocapture  # full flop solve (~3 min, ~1.5 GB)
```

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
