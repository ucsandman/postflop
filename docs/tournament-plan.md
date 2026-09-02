All load-bearing claims check out against source, and I re-ran the ICM DP: vectors match to 4 dp, the pair sum under a bubble falls 200.00 → 199.93 → 198.31 → 193.17 → 184.44 as chips move (so HU ICM is general-sum, the engine map is wrong on that point), and winner-take-all reproduces chip proportions exactly. Final plan below.

# Tournament extension plan: HU ICM first, table size is config, multiway is a spike

## 1. Executive summary

1. Your solver is heads-up only, and that is fine: at a 6-max or 8-max tournament table nearly every postflop spot worth studying is two players with ICM pressure. The whole table enters the solve through the ICM stack vector, not through a multiway tree.
2. Every chip payoff in the engine is born at one function (`engine/src/nlhe.rs:397 term_data`), so ICM is a payoff-function change plus a `[tournament]` config block. The CFR core, i16 storage, locking and parallel fork need zero changes; chipEV solves stay bit-identical.
3. Ship order: Stage 0 fingerprint lock (half a day), Stage 1 engine ICM (about 5 days), Stage 2 CLI/wasm/web surfaces with the chipEV-vs-ICM side-by-side (about 5 days). After that you can set up a final-table spot with real per-seat stacks and a payout structure, solve it, and read $EV, bubble factor and the strategy delta.
4. Honesty cost paid up front: under ICM the two players' equities do not sum to a constant, so the headline "exploitability" becomes NashConv, reported per player, with the caveat that zero does not certify a minimum EV.
5. Three-way solving is a two-day spike that produces a go/no-go, not a feature. The market leader took a year between 3-way chipEV and 3-way ICM and still ships it at one bet size; nothing multiway ships from this plan.

## 2. What is and is not measurable

**HU chipEV (today, unchanged by every stage).** The game is exactly zero-sum per combo pair (`game.rs:42`, tested at `nlhe.rs:1404`). `br[0] + br[1]` is a genuine upper bound on what either player can gain by deviating and bottoms out at 0 at Nash. This is the only configuration in the plan where the headline number is a guarantee, and it stays that way.

**HU ICM.** The game is general-sum: not zero-sum and not constant-sum. Measured on a 10-man SNG (1500 each, 500/300/200): the two contesting players' summed equity is 200.00 at rest, 199.93 after a 100-chip transfer, 198.31 after 500, 193.17 after 1000, 184.44 after 1500. The difference leaks to the frozen field, or drains from it when stacks converge. So `br[0] + br[1]` (`br.rs:98`) is not offset the way rake offsets it (`br.rs:25`); it is meaningless. What can be measured: each player's unilateral best-response gain against the profile, `gain_i = BR_i - EV_i`, and their sum NashConv. In chips `EV_0 + EV_1 = 0`, so NashConv equals today's number exactly. What cannot: a guaranteed minimum EV, uniqueness of the equilibrium value, or the claim that a zero-gain profile is safe. PioSOLVER's own docs carry the same caveat. Two consequences users will report as bugs and are not: adding bet sizes can lower both players' EV, and playing the equilibrium against a mistake can lose $EV.

**The ICM model itself.** Exact Malmuth-Harville, nothing else. It ignores blind levels, assumes equal skill, does not look ahead (no position rotation, no cost of posting), and does not know other tables exist. Not FGS, not Malmuth-Weitzman (no published vector to verify against), not bounties.

**Multiway.** With three or more players CFR minimizes external regret and converges to the set of coarse correlated equilibria, not Nash. Published evidence: 3-player Kuhn reaches per-player gain ~0.0017 antes/hand after 1e8 iterations; 3-player Leduc, the toy with community cards and split pots, stalls at ~0.12 and does not converge. More iterations do not close that gap. No exploitability exists and none will be claimed. If a multiway number is ever reported it is a per-player gain vector with max, labelled as a measurement of one profile, with the best-response type stated (independent, not team). The exception is fold-induced two-player subgames, where the real bound returns and should be reported separately.

## 3. Stages in ship order

### Stage 0. Fingerprint lock on today's main (half a day)

Grafted from N-First. The repo has no cross-commit bit-identity gate (`milestone3_is_bit_identical_across_identical_solves` compares a run to itself). Every later "chipEV unchanged" claim is measured against this file.

- **New** `engine/tests/fingerprint.rs`: copy the 12-line `strategy_fingerprint` from `engine/tests/milestone4.rs:256` verbatim (do not lift it into the library). Fingerprint five solves and hard-code the u64 plus exact f32 bit constants for `expected_value(0/1)` and `exploitability().chips`: Kuhn, AKQ (all three variants), milestone3 river, milestone4 small flop f32, milestone4 small flop i16. Print nodes/terminals/iters/combo widths beside each assertion.
- Config/format/UI: none.
- **Verify:** green twice, with and without `--features parallel`. Negative control: change `cfr.rs:918` `parent[o_off + p] * edge.weight` to drop the weight, confirm fingerprints 3/4/5 go red, revert. Second: alpha 1.5 → 1.4, all five red, revert.
- Risk: platform-sensitive floats. If CI differs, commit a per-target table; never weaken to an epsilon.

### Stage 1. Engine ICM, heads-up, exact (about 5 days)

Four commits in order, each with its own gate. Detailed in section 4.

- 1a `engine/src/icm.rs` standalone, wired into nothing (half day).
- 1b explicit chop payoff in `terminal.rs`, bit-identical no-op (1 hour).
- 1c `[tournament]` config, validated, inert; format version 3 (1 day).
- 1d ICM payoffs in `term_data`, NashConv in `br.rs`, unit tag in `SolveMeta` (2-3 days, mostly the verification matrix).

### Stage 2. Surfaces: CLI, wasm, web (about 5 days, mostly TypeScript)

Engine: `icm::bubble_factors(stacks, payouts) -> Vec<Vec<f64>>` (pairwise, asymmetric; derived from `equity`, nothing cached).

CLI (`cli/src/solve.rs`):
- `SolveArgs:46` gains `--tournament <file.toml>` whose `[tournament]` table is merged into the config in the existing override window (`:100-120`) before `validate()` at `:121`. Set once, reused across boards.
- `print_final_report:195` under ICM prints `payoff unit: cste`, per-seat EV, NashConv as chips and % of pot, `gain` per player, bubble factor per seat, and the volume line `icm: N seats, K paid, T terminals mapped`. Keep the literal `OOP EV` substring: `cli/tests/cli.rs:90` pins it.

wasm (`wasm/src/lib.rs`): `meta():446` emits `payoff_unit`, `gain: [f32;2]`, and `tournament` (stacks/payouts/seats) when present. `check_player:366` unchanged; `smoke.mjs:263` keeps pinning `combo_evs(0, 7)` throws.

Web:
- `web/lib/types.ts:57` `Meta` gains `payoff_unit?: "chips" | "cste"`, `gain?: [number, number]`, `tournament?`. Do not widen `PLAYER_NAMES`, `stacks`, `player: 0|1`, `RootEvs`, `root_combos`.
- `web/lib/config.ts`: `SolveForm` gains optional `tournament: { payouts: string; stacks: string; seats: [number, number] }` (solve-affecting, so on `SolveForm`, not `SpotContext`). `toToml:360` emits the block. `spotKey:297` MUST include payouts, stacks and seats; a lock captured under one payout structure otherwise resolves silently against another, the exact failure the key's doc comment exists to prevent. `isSolveForm:407` treats a missing block as none, so saved forms keep loading.
- `web/components/SolvePanel.tsx:282` table-context block: add a stack field per seat and a payouts editor (paste a list, or one of five presets in a JSON file: winner-take-all, standard MTT, flat, top-heavy, satellite). Presets are data, not a feature. Show the chosen structure on every result; payouts have no sensible default.
- `web/components/Workbench.tsx:1207` StatBand: root EV tiles read `meta.payoff_unit`; add a NashConv-per-player tile and a pairwise bubble-factor tile. New `.bar-icm` stripe token in `web/app/globals.css:132-135`; do not borrow one.
- Headline surface: chipEV-vs-ICM side by side. Same form, two solves (one with the tournament block stripped), `buildGrid` on both, render per-cell frequency deltas. Nearly free, and every published ICM lesson is shaped this way.
- `web/components/ComboPanel.tsx:145` footnote currently promises "zero-sum net big blinds". Under ICM it reads the unit tag and says CSTE, not zero-sum.
- Display convention: solve in CSTE, display in bb and % of pot as today; the root tile and all-in terminals also show raw $.
- `web/lib/trainer.ts:156` `HandRecord` gains `unit` (missing = chips); `isRecord:175` keeps rejecting mixed rows. Grading stays in fraction-of-pot; CSTE keeps the thresholds dimensionally sane.
- Copy sweep in the same change: `web/app/layout.tsx:14-31`, `web/components/Help.tsx:63`, `cli/src/main.rs:11`, `Workbench.tsx:716` "HU NLHE WORKBENCH", README. The postflop game is still heads-up; the table is not.

**Verify:** `cli/tests/cli.rs` four green unchanged, new case: `--tournament` output contains `NashConv` and the volume line; malformed file exits non-zero naming the seat. `wasm/smoke.mjs:88` root-EV reconciliation (`sum(w*ev)/sum(w) == root_evs.zero_sum`) holds on an ICM solution; if not, per-combo and root paths disagree and one is wrong. `web/lib/config.test.ts:98-192` extended: `spotKey(meta) === spotKey(form)` on a tournament spot, and `toToml` throws when only the payouts differ; revert-to-red by removing the tournament fields from `spotKey` and confirm the throw stops. Bubble-factor matrix: assert `BF(i,j) != BF(j,i)` on a covered/covering pair. chipEV-vs-ICM diff on a committed fixture: ICM check frequency strictly higher on a named node, both numbers committed as constants. Rendered proof: open the workbench on a solved ICM spot, confirm the $EV tile, bubble factor and the side-by-side render with real data, zero terminal commands in the human's path.

### Stage 3. Multiway: a gated spike that produces a decision (2 days)

Nothing ships from this stage. A scratch binary or `#[ignore]`d test, touching no production path.

- A naive O(N·M·K) three-range showdown reference (single winner, 3-way chop, 2-of-3 chop with the third losing) on a reduced 12-16 card deck, plus one side-pot layer.
- The derived O(52·(N+M+K)) fast form: product of two rank prefix sums, each with the existing 52-accumulator inclusion-exclusion, minus the opponent-vs-opponent overlap term (the only part that does not factorise), minus the running same-combo term. This derivation is unpublished and unverified; the oracle is the point.
- One cheap production fix, independent of the outcome: `config.rs:149 BetSizings::player` returns IP's tables for any non-zero id. Add `debug_assert!(player < 2)`.
- Do not touch `Game::terminal_utility`, `ChanceEdge::parent_of_child`, `Cfr::walk`, `Br::walk`, `Terminal::Fold`, or `tree.rs:492 let o = 1 - p`.

**Gate:** fast path equals brute force exactly on 200+ random reduced-deck cases including ties and a side-pot layer, AND the measured constant is within 2x of ~52x over the 2-way sweep. Negative controls: delete the overlap correction, red; delete the j==k term, red differently. Volume line printed: cases, widest ranges, layers, tie groups.

Even on a pass, the build (per-seat stacks with the `tree.rs:626 call_child` uncalled-excess bug, `Terminal` side-pot layering, live-player rotation, `nlhe.rs:265` `outcomes - 4` becoming `outcomes - 2*players`, fold-to-HU subgames reported with the real bound) is weeks and gets its own plan. The default answer is no.

## 4. Stage 1 in implementation detail

### 1a. `engine/src/icm.rs` (new; add `pub mod icm;` to `engine/src/lib.rs` between `iso` and `nlhe`)

```rust
/// Exact Malmuth-Harville tournament equity, one value per stack, in payout units.
/// Subset DP over the set of players already placed; O(n * sum_{k<K} C(n,k)).
/// A zero stack gets zero and never enters a denominator.
pub fn equity(stacks: &[f64], payouts: &[f64]) -> Vec<f64> {
    let n = stacks.len();
    let places = payouts.len().min(n);
    let total: f64 = stacks.iter().sum();
    let mut ev = vec![0.0; n];
    // g[S] = P(the set S occupies places 1..|S| in some order). Keyed by bitmask.
    let mut g: HashMap<u32, f64> = HashMap::from([(0u32, 1.0)]);
    for place in 0..places {
        let mut next = HashMap::new();
        for (&set, &p) in &g {
            let remaining = total - (0..n).filter(|&i| set >> i & 1 == 1).map(|i| stacks[i]).sum::<f64>();
            for i in 0..n {
                if set >> i & 1 == 1 || stacks[i] <= 0.0 { continue; }
                let q = p * stacks[i] / remaining;        // absolute chips, never 1 - sum(fractions)
                ev[i] += q * payouts[place];
                *next.entry(set | 1 << i).or_insert(0.0) += q;
            }
        }
        g = next;
    }
    ev
}

/// (eq_now - eq_lose) / (eq_win - eq_now) for hero risking `risk` chips against `villain`.
pub fn bubble_factor(stacks: &[f64], payouts: &[f64], hero: usize, villain: usize, risk: f64) -> f64 {
    let now = equity(stacks, payouts)[hero];
    let mut w = stacks.to_vec(); w[hero] += risk; w[villain] -= risk;
    let mut l = stacks.to_vec(); l[hero] -= risk; l[villain] += risk;
    (now - equity(&l, payouts)[hero]) / (equity(&w, payouts)[hero] - now)
}
// required_equity(bf) = bf / (bf + 1). Do NOT hardcode RP = bf/(bf+1) - 0.5; it is only exact
// for a symmetric all-in with no dead money. Compute both from `equity`.
```

`u32` mask caps at 32 seats; `validate()` rejects more. `ponytail:` HashMap per place, swap for a flat 2^n array if a profile ever cares.

**Tests (all in `icm.rs`):**
- `[50,30,20]` / `[70,30]` → `[45.1786, 32.25, 22.5714]` within 1e-4.
- `[150000,98750,45500,13250]` / `[425,280,130,75]` → `[323.20, 278.12, 195.79, 112.89]` within 1e-2.
- Negative control: the same input must NOT equal chip-proportional `[443.90, 292.24, 134.65, 39.21]`.
- 10×1500, `[500,300,200]`: every seat 100.0; hero 3000 with one seat at 0 → 184.4444; `bubble_factor(.., risk=1500)` = 1.1842; required equity 0.5422.
- Invariants over 20 random vectors: `sum(equity) == sum(payouts)` within 1e-9; equal stacks → equal equity exactly; zero stack → 0.
- Print `subsets evaluated = N` per case (46 for 9 players, 3 paid).

### 1b. Explicit chop (bit-identical)

- `terminal.rs:195 showdown_ev_ranked` gains `chop: f64`; delete `:210`. `:267` unchanged.
- `terminal.rs:287 showdown_ev` wrapper and `terminal.rs:337 reference::showdown_ev` both take `chop` (the oracle must not keep the linearity the fast path gave up).
- `nlhe.rs:122 TermData` gains `chop: [f64; 2]`; `term_data` sets `(win[p] + lose[p]) * 0.5` in f64; `nlhe.rs:573` passes `t.chop[h]`. `fold_ev` unchanged.
- **Verify:** Stage 0 fingerprints byte-identical; `terminal.rs:443/480/510/585/610` green with no expected-value edits. New `chop_is_not_derived`: royal-flush board, `win=10, lose=-10, chop=0` → all 0.0; `chop=7` → `7 * live`. Land as its own commit.

### 1c. Config and format (inert)

TOML shape:

```toml
[tournament]
# Prize per finishing place, index 0 = first. Shorter than `stacks` is fine; the rest pay 0.
payouts = [500, 300, 200]
# Chips behind at the root of THIS node, every remaining seat, in seat order. Preflop
# investments are already in `starting_pot`. Do not enter start-of-hand stacks.
stacks  = [3000, 1500, 1500, 900, 600, 1100]
# Indices into `stacks`: [OOP seat, IP seat].
seats   = [1, 3]
```

Rust, `engine/src/config.rs`, following the `Rake` idiom at `:181`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tournament {
    pub payouts: Vec<f64>,
    pub stacks: Vec<f64>,
    pub seats: [usize; 2],
}
// on SolveConfig, after `locks`:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub tournament: Option<Tournament>,
```

`skip_serializing_if` is load-bearing: without it `config.rs:667 full_toml_roundtrips` and `:694 minimal_toml_uses_defaults` fail.

`validate()` new arm, exact rejections with messages naming the offending value:
1. `stacks.len()` in 2..=32; every stack finite and >= 0; at least two positive.
2. `payouts` non-empty, non-increasing, all >= 0, sum > 0, `payouts.len() <= stacks.len()`.
3. `seats` distinct and `< stacks.len()`.
4. `stacks[seats[p]] >= effective_stack - EPS` for both p (the covering seat may exceed it).
5. `min(stacks[seats[0]], stacks[seats[1]]) == effective_stack` within EPS. The tree seeds both players from one scalar (`tree.rs:233`); a config where neither in-hand seat equals it describes a spot the tree does not build. This closes Design 3's validation gap.
6. `rake.percent == 0`. Tournament pots are not raked; PioSOLVER refuses the combination too. Rejecting is one line and removes the need to document an application order.

Why this is not the "equal stacks forever" limitation the judges flagged in ICM First: the covering seat's excess `stacks[seat] - effective_stack` never enters the pot in a HU tree (an all-in is capped at the effective stack), so it rides through every terminal as a constant added to that seat's final stack. The tree is untouched; only the ICM vector sees it. Per-seat unequal stacks inside the tree (side pots) remain a separate project.

Jump-point payout entry (`[{amount, seats}]` rows expanded to the flat list) lives in the CLI/web layer, not in the engine type. Engine takes the flat list only.

`engine/src/solution.rs`: `FORMAT_VERSION = 3`. Stamp rule at `:190`: no locks and no tournament → 1; locks only → 2; tournament → 3. `SolveMeta` gains `#[serde(default)] pub payoff_unit: String` (`"chips"` | `"cste"`) and `#[serde(default)] pub gain: [f32; 2]`.

**Verify:** `config.rs:667/:694/:711` unchanged and green; new: unknown key inside `[tournament]` rejected; six rejection cases with messages (duplicate seats, seat out of range, ascending payouts, more payouts than stacks, neither seat equal to effective_stack, rake with tournament). `solution.rs:377` still asserts version 1, `:425` version 2, new case asserts 3, `:489` unchanged. `cli/tests/fixtures/*.toml` untouched, four CLI tests green.

### 1d. ICM payoffs and NashConv

`nlhe.rs:397 term_data`, ICM branch when `cfg.tournament` is `Some(t)`:

```
scale  = sum(t.stacks) + starting_pot            // total chips at the table
       / sum(t.payouts)                          // CSTE: payoffs come out in tournament-equity chips
base   = t.stacks with base[seat_p] += starting_pot/2 for both in-hand seats
root   = icm::equity(base, payouts)              // computed once per game, not per terminal
for outcome in {win, lose, chop}:
    award = net | 0 | net/2                      // net == pot, rake is rejected
    final = t.stacks with final[seat_p] = t.stacks[seat_p] - effective_stack + node.stacks[p] + award_p
                                        and final[seat_q] = t.stacks[seat_q] - effective_stack + node.stacks[q] + (pot - award_p)
    payoff[p] = (icm::equity(final, payouts)[seat_p] - root[seat_p]) * scale
```

The `starting_pot/2` in `base` is the existing re-centering convention (`nlhe.rs:401`); under winner-take-all the delta collapses to `net - stake[p]` exactly. Chip path is the untouched original branch. No memo: ~1e5 terminals × 3 calls × microseconds is under a second on a full flop tree; `ponytail:` memoize on `(pot.to_bits(), node.stacks[0].to_bits())` if the build profile ever says otherwise.

`nlhe.rs:518 ev_pot_share`: under ICM return `ev + root[seat] * scale` (absolute equity of the seat in CSTE chips) instead of `ev + starting_pot/2`. Same slot, useful number, no format change.

`engine/src/game.rs`: add `fn zero_sum(&self) -> bool { true }` to the trait. `NlheGame` returns `cfg.tournament.is_none()`.

`br.rs:93 exploitability`:

```rust
let br = [best_response_value(game, 0, profile), best_response_value(game, 1, profile)];
let gain = if game.zero_sum() {
    [br[0], br[1]]                                            // EV_0 + EV_1 == 0: no extra walks, bit-identical
} else {
    [br[0] - expected_value(game, 0, profile), br[1] - expected_value(game, 1, profile)]
};
let chips = gain[0] + gain[1];                                // NashConv; equals br[0]+br[1] in chips
ExploitReport { br, gain, chips, pct_of_pot: 100.0 * chips / game.root_pot() }
```

`pct_of_pot` stays meaningful because CSTE puts NashConv and `starting_pot` in the same unit. Module docs in `br.rs:14` and `nlhe.rs:46` gain the general-sum paragraph from section 2: which best response is computed (unilateral, opponent fixed), and that zero NashConv certifies no minimum under ICM. `cli/src/solve.rs` and the web print "NashConv" when the unit is not chips; never "exploitability".

**Verify, in this order:**
- `chip_path_is_bit_identical`: all five Stage 0 fingerprints unchanged. Non-negotiable.
- `winner_take_all_reproduces_the_chip_solve`: `payouts = [sum(stacks) + starting_pot]` with every chip at the table makes ICM exactly linear and CSTE scale exactly 1. Assert max abs strategy difference vs the chipEV solve < 1e-4 and NashConv within 1e-4. Not bit-identical: the two payoff paths reach `term_data` through different f64 arithmetic (this resolves Judge 1's flaw in ICM First).
- `icm_leaks_equity_to_the_field` (shape of `nlhe.rs:1439`): on the 10×1500 / 500-300-200 spot with `seats` at two 1500 stacks, at every chip-moving terminal `u0 + u1 < 0`, AND the sum VARIES across terminals (a constant-sum bug would pass a plain non-zero check). Expected in $ before CSTE: about -1.70 at a 500-chip transfer, -15.56 at 1500.
- `satellite_moves_the_strategy` (negative control): seven equal prizes on the same spot; a named node's aggression frequency moves by more than 10 points versus chipEV. A no-op ICM path cannot pass this and the WTA gate together.
- Revert-to-red on the chop: restore `(win+lose)*0.5` in `term_data` under ICM and assert the concave-chop gate fails by a printed margin.
- Fail-on-purpose on the metric: nodelock one player to always-fold on an ICM spot and assert that player's `gain` explodes past 5% of pot.
- `every_terminal_is_zero_sum_per_combo_pair` (`nlhe.rs:1404`), `rake_makes_the_game_constant_sum` (`:1439`), `cfr.rs:1415` zero-sum gate, `locking.rs:212`: all untouched, all chip configs, all green.
- `gain` sums to `chips` exactly in the chip case; `per-seat` values printed.
- Convergence evidence committed, repo style: NashConv curve for a bubble spot in CSTE chips and % of pot with iteration and terminal counts beside it.
- Magnitude sanity, printed not asserted: a 30bb final-table SRP should check the flop more often under a flat structure than a top-heavy one (published: 66% top-heavy / 82% flat).

Risks: satellite and near-flat structures push BF toward 27 and near-pure strategies; test them deliberately. The i16 gate thresholds (`cfr.rs:1351 TRACK_ABOVE`, `:1413-1415`) are chip-calibrated; ICM solves may use `--storage i16` but no i16 parity claim is made until those are re-measured on a CSTE run. Do not delete or loosen them.

## 5. What not to build

- **A display-only $ conversion of a chipEV solve.** ICM changes the strategy at every node. Rescaling a chip solution produces confident wrong answers in exactly the spots the tool is bought for.
- **The zero-sum approximation** (hero gets `u_hero - u_villain`). It restores the convergence proof by deleting leakage, which is the whole postflop ICM effect. No vendor does it. If ever needed, an explicit flag with the caveat recorded.
- **Malmuth-Weitzman, FGS, bounties, Monte Carlo or large-field ICM.** One model, exact, to 32 seats. FGS is a preflop push/fold construct that re-solves the next hand and does not compose with a street-by-street solve. Bounties flip BF below 1 and are a second equity model.
- **Rake plus ICM.** Rejected in `validate()`. Tournament pots are not raked.
- **Per-seat stacks inside the tree, side pots, `call_child` excess return.** Blocked at `config.rs:414`, `tree.rs:233/626/652/658`. A real project with its own plan; not a prerequisite for ICM. Note the latent `tree.rs:626` bug (caller's excess never returned) becomes live the day stacks differ.
- **Widening `PLAYER_NAMES`, `NodeInfo.stacks`, `player: 0|1`, `RootEvs`, `root_combos`, `check_player`, or `Game::terminal_utility`.** The engine is two-player and the types should keep saying so. Widening ahead of the engine turns a compile error into a thrown exception inside a `useMemo`.
- **The N-player trait/`Cfr::walk`/`Br::walk` rewrite.** ICM needs none of it (verified: `cfr.rs` and `br.rs` never see chips), and it is 3-4 days on the hottest, most bit-identity-fragile code in the crate for a feature with roughly 8:1 lower demand.
- **Any multiway in Stages 0-2.** Stage 3 is a spike that answers a question. If it passes, the build (fold-to-HU subgames with the real bound, side-pot layering, `outcomes - 2*players`, single-size trees, `WARN_BYTES`/`HARD_BYTES` retuning) is a separate plan.
- **Tournament-ID import or a structure database.** Five JSON presets plus paste-your-own.
- **A payoff-model trait or ICM abstraction layer.** `Option<Tournament>` on the config, one branch in `term_data`, one defaulted trait method, one branch in `br.rs`. That is the whole thing.
- **Deleting `every_terminal_is_zero_sum_per_combo_pair`.** It keeps guarding the chip path. ICM gets its own true invariant (leakage varies and is negative on a bubble), never a constant-sum assertion on the $ values, because there is none.

## Judge-named flaws, resolved

| Flaw | Resolution |
|---|---|
| ICM First: linearity gate demands bit-identity across different f64 paths | Tolerance 1e-4 on strategies and NashConv; CSTE scale 1 under WTA makes the math exact, the float order still differs |
| ICM First: forces both in-hand stacks equal to `effective_stack`, scopes covering stacks out | Design 3's per-seat `stacks` with the covering seat's excess as a terminal-invariant constant; validation requires `min == effective_stack` (Judge 2's tightening) |
| Design 3: validation accepted both seats above `effective_stack` | Rule 5 above |
| N-First: rewrites `Cfr::walk`/`Br::walk` before ICM | Not adopted; the winner never touches either. Stage 0 fingerprint lock, per-player gain vector, `BetSizings` bound check and the `call_child` note are grafted |
| N-First: bubble-factor tile with no engine function | `icm::bubble_factor` and `bubble_factors` defined in 1a/Stage 2 |
| Engine map: "HU ICM stays constant-sum, subtract the constant" | Wrong; measured 200.00 → 184.44. NashConv replaces `br[0]+br[1]` only when `zero_sum()` is false |
| All three: unpublished 3-way inclusion-exclusion | Confined to the Stage 3 spike, oracle-gated, flagged unverified, ships nothing |

## Stage 3 spike result (2026-09-01): gates passed, build is NO-GO

Spike lives at engine/examples/multiway_spike.rs (no production path; the one
production change is the debug_assert in BetSizings::player).

- Oracle: 210 random reduced-deck cases, 1,818,743 triples, widest range 55
  combos, 420 pot layers (140 with hero eligible for a side pot), 1,026 tie
  groups, 307,218 three-way and 331,024 two-way chops. Fast form vs naive:
  worst max_rel 7.18e-13. Both negative controls red on 210/210 cases by
  different margins (86.1 vs 6.58).
- Constant: the three-way showdown sweep costs 24.9x the two-way sweep per hero
  combo (164 ns vs 6.6 ns, full deck, 1081 combos per range) against a gate of
  104x. The naive form measures 10,323x on the same harness.

Why still no: 25x is the per-terminal floor of one function, not a solve time;
3-player CFR converges to coarse correlated equilibria (no exploitability
exists to report); the actual build (per-seat stacks in the tree with the
latent tree.rs call_child excess bug, side-pot terminals, live-player rotation,
fold-to-HU subgame reporting, memory gate retuning) is weeks on the most
bit-identity-fragile code in the crate. Reopen only with a real user need for
three-way postflop ICM and the weeks to pay for it.
