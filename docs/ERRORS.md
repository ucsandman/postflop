# Errors and lessons

Newest first. Symptom → root cause → fix.

## 2026-09-01 — EV grid averaged with reach instead of EV weights

Symptom: `buildEvGrid` weighted per-combo EVs by `combos[i].weight` (reach
only), so on wet boards a cell's best action, margin, and regret could all be
wrong — the exact numbers the new overlays advertise. Root cause: the engine
documents `combo_ev_weights` (reach × compatible opponent mass) as the only
weight that averages EVs correctly, and the sibling `buildRunoutHotness` in the
same file followed the rule while `buildEvGrid` did not; the unit test put one
combo per cell so intra-cell weighting was never exercised. Fix: pass
`combo_ev_weights` through, plus a two-combos-one-cell regression test.
Lesson: any new EV aggregation in web/lib must cite `combo_ev_weights`'s doc
comment, and its test must put ≥2 combos with different weights in one cell.

## 2026-09-01 — Unconditional lock renormalization broke bit-for-bit lock tests

Symptom: adding always-on per-column renormalization in `NodeLock::expand`
failed `a_lock_on_every_node_reproduces_the_profile_exactly` (last-ulp drift).
Root cause: a converged average strategy's columns sum to 1 ± a few f32 ulps;
dividing by that sum shifts ulps, and the test pins the fully-locked profile
bit-for-bit on purpose (it catches lock-plumbing corruption). Fix: renormalize
only columns off by more than 1e-6. Lesson: before "fixing" float hygiene,
check which tests deliberately pin bit-identity.

## 2026-09-01 — Node locks silently re-applied across spot edits

Symptom: a lock captured on one board re-resolved on a different board whenever
player/action/combo arity happened to match, silently freezing the wrong
strategy. Root cause: a lock line ("check,bet:50") carries no provenance about
the spot it was read from. Fix: web locks stamp a normalized `spot` key and
`toToml` refuses a mismatch; the panel marks stale locks before solving.
