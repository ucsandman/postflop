# Decisions

Durable design decisions, newest first. Each entry: context → decision → why.

## 2026-09-01 — Node locking lives on the `Game` trait, not the `Solver`

`Game::locked_strategy(node) -> Option<&[f32]>` (defaulted to `None`) is the
single seam: both the CFR walk and the best-response walk already hold `&G`, so
one method reaches every consumer with no new plumbing, no new `Solution`
field, and no change to the toy games. Locks persist as part of `SolveConfig`
(`[[locks]]`), which the solution file already embeds and rebuilds from.

At a locked node only the locking player's regret and average-strategy updates
are frozen; the value fold still runs so the opponent's counterfactual values
stay correct. Exploitability under a lock means: the locked player cannot
deviate at locked nodes, the unlocked player best-responds normally.

## 2026-09-01 — Lock columns renormalize only past 1e-6

`NodeLock::expand` accepts per-combo sums within `LOCK_TOL` (1e-3) but a
hand-written lock summing to 1.0009 would silently scale every reported chip
figure. Columns off by more than 1e-6 are renormalized; columns within 1e-6
(a round-tripped converged strategy, off by accumulated f32 ulps only) are
frozen verbatim, because `engine/tests/locking.rs` deliberately pins the
fully-locked profile bit-for-bit.

## 2026-09-01 — Solution files stamp v1 unless they carry locks

A lock-free solve is layout-identical to a version-1 file, so
`Solution::from_solver` stamps `format_version: 1` and stays readable by older
builds (deployed wasm bundles, older CLIs). Only a file that actually embeds
locks gets version 2, which v1 builds refuse — the refusal is the point: a v1
build would rebuild the tree without the locks and silently solve a different
game.

## 2026-09-01 — Web feature math is pure functions in `web/lib/`, tested without a framework

EV/regret grids, blocker scores, runout hotness, and trainer grading are pure
functions in `web/lib/grid.ts` and `web/lib/trainer.ts`, tested by plain
`node --experimental-strip-types` scripts (`npm test`). Per-combo EVs average
with `combo_ev_weights` (reach × compatible opponent mass), never bare reach —
the wasm doc comment on `combo_ev_weights` is the authority.
