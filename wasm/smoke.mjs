// Real-binary smoke test for the wasm bindings.
//
//   wasm-pack build wasm --target nodejs --out-dir pkg-node
//   node wasm/smoke.mjs
//
// Loads the actual compiled module from pkg-node and asserts against the two solution
// fixtures on disk plus one inline in-browser solve. Every verdict prints the volume it
// covered — a check that passed over nothing is not a passing check.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const require = createRequire(import.meta.url);
const wasm = require(join(here, "pkg-node", "solver_wasm.js"));

let checks = 0;
const ok = (label, detail) => {
  checks += 1;
  console.log(`  PASS  ${label}${detail === undefined ? "" : `  [${detail}]`}`);
};
const close = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------------
// Fixture checks
// ---------------------------------------------------------------------------------

function checkFixture(name, { expectRootActions, expectStreet }) {
  console.log(`\n=== ${name} ===`);
  const text = readFileSync(join(repo, name), "utf8");
  const raw = JSON.parse(text);
  const h = wasm.load_solution(text);

  // --- meta matches the file exactly ---
  // The engine stores these as f32. JSON round-trips them through a decimal shortest
  // representation of the f32, which Rust then re-prints widened to f64, so compare on
  // the f32 both sides actually hold: Math.fround, not the two decimal strings.
  const meta = JSON.parse(h.meta());
  console.log(`  meta: ${JSON.stringify(meta)}`);
  assert.equal(meta.exploitability_chips, Math.fround(raw.meta.exploitability_chips));
  assert.equal(meta.exploitability_pct_of_pot, Math.fround(raw.meta.exploitability_pct_of_pot));
  assert.equal(meta.iterations, raw.meta.iterations);
  assert.equal(meta.engine_version, raw.meta.engine_version);
  assert.equal(meta.node_count, raw.node_count);
  assert.equal(meta.street, expectStreet);
  ok("meta.exploitability matches the file", `${meta.exploitability_pct_of_pot.toFixed(4)}% of pot`);

  // --- root is a decision node with the expected shape ---
  const root = JSON.parse(h.node(0));
  console.log(`  root: ${JSON.stringify(root)}`);
  assert.equal(root.kind, "decision");
  assert.equal(root.actions.length, expectRootActions);
  assert.equal(h.num_actions(0), expectRootActions);
  assert.equal(root.player, 0);
  ok("root is a decision node with the expected action count", `${root.actions.length} actions`);

  // --- every combo's strategy vector sums to 1 at every decision node ---
  let vectors = 0;
  let worst = 0;
  let decisionNodes = 0;
  for (let id = 0; id < h.node_count; id += 1) {
    if (h.num_actions(id) === 0) continue;
    decisionNodes += 1;
    const node = JSON.parse(h.node(id));
    const nActions = node.actions.length;
    const nCombos = h.combo_count(id, node.player);
    const s = h.strategy(id);
    assert.equal(s.length, nActions * nCombos, `node ${id} strategy length`);
    for (let i = 0; i < nCombos; i += 1) {
      let sum = 0;
      for (let a = 0; a < nActions; a += 1) sum += s[a * nCombos + i];
      worst = Math.max(worst, Math.abs(sum - 1));
      vectors += 1;
    }
  }
  assert.ok(worst <= 1e-4, `worst strategy-sum deviation ${worst}`);
  ok(
    "every combo strategy vector sums to 1",
    `${vectors} vectors over ${decisionNodes} decision nodes, worst |sum-1| = ${worst.toExponential(3)}`
  );

  // --- combo_evs at the root aggregate to the stored root EV ---
  const rootEvs = JSON.parse(h.root_evs());
  console.log(`  root_evs: ${JSON.stringify(rootEvs)}`);
  assert.deepEqual(rootEvs.zero_sum, raw.meta.root_evs.zero_sum.map(Math.fround));
  for (const player of [0, 1]) {
    const evs = h.combo_evs(0, player);
    const w = h.combo_ev_weights(0, player);
    const combos = JSON.parse(h.combos(0, player));
    assert.equal(evs.length, combos.length);
    assert.equal(w.length, combos.length);
    let finite = 0;
    let num = 0;
    let den = 0;
    for (let i = 0; i < evs.length; i += 1) {
      assert.ok(Number.isFinite(evs[i]), `player ${player} combo ${combos[i].cards} ev ${evs[i]}`);
      finite += 1;
      num += w[i] * evs[i];
      den += w[i];
    }
    const mean = num / den;
    const delta = Math.abs(mean - rootEvs.zero_sum[player]);
    close(mean, rootEvs.zero_sum[player], 1e-4, `player ${player} reach-weighted mean vs root_evs`);
    ok(
      `combo_evs finite and reach-weighted mean == root_evs.zero_sum[${player}]`,
      `${finite} combos, mean ${mean.toFixed(8)} vs ${rootEvs.zero_sum[player].toFixed(8)}, delta ${delta.toExponential(2)}`
    );
  }

  // --- to_json round-trips back through load_solution ---
  const again = wasm.load_solution(h.to_json());
  assert.equal(again.to_json(), h.to_json());
  assert.equal(again.meta(), h.meta());
  assert.equal(JSON.stringify(again.node(0)), JSON.stringify(h.node(0)));
  ok("to_json round-trips through load_solution", `${h.to_json().length} chars identical`);

  return h;
}

// ---------------------------------------------------------------------------------

console.log("solver-wasm smoke test (real pkg-node binary)");
console.log(`  wasm module: ${join(here, "pkg-node", "solver_wasm_bg.wasm")}`);

const river = checkFixture("fixture-river.json", { expectRootActions: 2, expectStreet: "river" });
const turn = checkFixture("fixture-turn.json", { expectRootActions: 2, expectStreet: "turn" });

// --- the river deal under bet/call on the turn spot exposes every remaining card ---
console.log("\n=== turn spot: chance node under bet -> call ===");
{
  const root = JSON.parse(turn.node(0));
  const bet = root.actions.find((a) => a.label === "bet");
  assert.ok(bet, `root has no bet action: ${JSON.stringify(root.actions)}`);
  const facing = JSON.parse(turn.node(bet.child));
  assert.equal(facing.kind, "decision");
  const call = facing.actions.find((a) => a.label === "call");
  assert.ok(call, `no call facing the bet: ${JSON.stringify(facing.actions)}`);
  const chance = JSON.parse(turn.node(call.child));
  console.log(
    `  node ${call.child}: kind=${chance.kind} street=${chance.street} board=[${chance.board}] ` +
      `valid_cards=${chance.valid_cards.length}`
  );
  assert.equal(chance.kind, "chance");
  assert.equal(chance.street, "river");
  // The board at the deal is the 4 turn cards; every one of the other 48 can come.
  const expected = 52 - chance.board.length;
  assert.equal(chance.valid_cards.length, expected);
  const cards = new Set(chance.valid_cards.map((c) => c.card));
  assert.equal(cards.size, expected, "duplicate cards in valid_cards");
  for (const b of chance.board) assert.ok(!cards.has(b), `board card ${b} offered as a deal`);
  for (const c of chance.valid_cards) assert.ok(c.child < turn.node_count, "child out of range");
  ok(
    "chance node exposes exactly the remaining deck",
    `${chance.valid_cards.length} valid_cards = 52 - ${chance.board.length} board cards`
  );

  // Combo EVs are defined off the root too, on a compacted (post-deal) combo set.
  const firstCard = chance.valid_cards[0];
  const afterDeal = JSON.parse(turn.node(firstCard.child));
  const evs = turn.combo_evs(firstCard.child, afterDeal.player ?? 0);
  const nan = [...evs].filter(Number.isNaN).length;
  console.log(
    `  after ${firstCard.card}: node ${firstCard.child} board=[${afterDeal.board}] ` +
      `combos=${evs.length} NaN=${nan}`
  );
  assert.ok(evs.length > 0);
  ok("combo_evs works below a chance edge", `${evs.length} combos, ${nan} undefined (zero mass)`);
}

// --- tree_stats preflight ---
console.log("\n=== tree_stats preflight ===");
{
  const toml = readFileSync(join(repo, "web-fixture.toml"), "utf8");
  const stats = JSON.parse(wasm.tree_stats(toml));
  console.log(`  ${JSON.stringify(stats)}`);
  assert.ok(stats.nodes.total > 0 && stats.strategy_entries > 0);
  assert.equal(stats.solver_storage_bytes, stats.strategy_entries * 8);
  assert.equal(stats.total_bytes, stats.solver_storage_bytes + stats.chance_map_bytes);
  ok(
    "tree_stats reports 8 bytes per (action, combo) pair",
    `${stats.strategy_entries} pairs -> ${stats.solver_storage_bytes} B solver + ${stats.chance_map_bytes} B maps`
  );
}

// --- parse_range / combo_labels ---
console.log("\n=== range utilities ===");
{
  const full = JSON.parse(wasm.parse_range("random"));
  assert.equal(full.num_combos, 1326);
  assert.equal(full.nonzero, 1326);
  const aces = JSON.parse(wasm.parse_range("AA"));
  assert.equal(aces.nonzero, 6);
  const labels = JSON.parse(wasm.combo_labels());
  assert.equal(labels.length, 1326);
  const acesLabels = aces.weights
    .map((w, i) => (w > 0 ? labels[i] : null))
    .filter(Boolean);
  console.log(`  AA -> ${acesLabels.join(" ")}`);
  assert.equal(acesLabels.length, 6);
  for (const l of acesLabels) assert.ok(/^A.A.$/.test(l), `not an ace pair: ${l}`);
  assert.throws(() => wasm.parse_range("ZZ"), /.*/);
  ok("parse_range + combo_labels agree on the 1326-combo axis", `AA = ${acesLabels.length} combos`);
}

// --- in-browser solve ---
console.log("\n=== solve_spot (tiny river spot) ===");
{
  const toml = `
board = "Ks 7d 2c 8h 3d"
oop_range = "KK,A4s,A5s"
ip_range = "TT,JJ"
effective_stack = 10.0
starting_pot = 10.0
raise_cap = 0
[sizings.oop.river]
bet = { percents = [100.0], allin = false }
[sizings.ip.river]
bet = { percents = [100.0], allin = false }
`;
  // Target 0.02% rather than the headline 0.5% so the run spans several report chunks
  // and the callback is exercised more than once.
  const progress = [];
  const solved = wasm.solve_spot(toml, 2000, 0.02, 100, (iter, chips, pct) => {
    progress.push([iter, chips, pct]);
  });
  const meta = JSON.parse(solved.meta());
  for (const [i, chips, pct] of progress) {
    console.log(`  progress iter ${i}  ${chips.toFixed(6)} chips  ${pct.toFixed(4)}% of pot`);
  }
  console.log(`  ${progress.length} progress callbacks total`);
  console.log(
    `  final: ${meta.iterations} iters  ${meta.exploitability_chips.toFixed(6)} chips  ` +
      `${meta.exploitability_pct_of_pot.toFixed(4)}% of pot  ${meta.wall_seconds.toFixed(3)} s`
  );
  assert.ok(progress.length >= 3, `progress fired only ${progress.length} times`);
  assert.equal(progress[0][0], 100, "first report should land on iteration 100");
  progress.forEach(([i], n) => assert.equal(i, (n + 1) * 100, "report interval drifted"));
  assert.equal(progress.at(-1)[0], meta.iterations, "last report is not the final iteration");
  assert.ok(
    meta.exploitability_pct_of_pot < 0.5,
    `did not converge: ${meta.exploitability_pct_of_pot}% of pot`
  );
  ok(
    "solve_spot converges below 0.5% of pot with progress firing",
    `${progress.length} callbacks, ${meta.iterations} iters, ${meta.exploitability_pct_of_pot.toFixed(4)}% of pot`
  );

  // A solved handle must survive the export/import round trip.
  const reloaded = wasm.load_solution(solved.to_json());
  assert.equal(reloaded.meta(), solved.meta());
  assert.deepEqual([...reloaded.strategy(0)], [...solved.strategy(0)]);
  ok("solved handle round-trips through load_solution", `node 0 strategy identical`);

  // Errors surface as thrown strings, not panics.
  assert.throws(() => wasm.solve_spot(toml, 10, 0.5, 0, () => {}), /report_every/);
  assert.throws(() => wasm.load_solution("{}"), /.*/);
  assert.throws(() => solved.node(99999), /out of range/);
  assert.throws(() => solved.combo_evs(0, 7), /player must be/);
  ok("bad input throws instead of panicking", "4 error paths");
}

// --- in-browser ICM solve ---------------------------------------------------------
// The same tiny river spot scored in tournament equity. The reconciliation below is
// the real gate: if the per-combo path and the root path disagree under a general-sum
// payoff map, one of them is wrong and the workbench would show a number nothing
// backs up.
console.log("\n=== solve_spot (ICM: 4-seat bubble, 3 paid) ===");
{
  const toml = `
board = "Ks 7d 2c 8h 3d"
oop_range = "KK,A4s,A5s"
ip_range = "TT,JJ"
effective_stack = 10.0
starting_pot = 10.0
raise_cap = 0
[sizings.oop.river]
bet = { percents = [100.0], allin = false }
[sizings.ip.river]
bet = { percents = [100.0], allin = false }
[tournament]
payouts = [500.0, 300.0, 200.0]
stacks = [10.0, 18.0, 25.0, 6.0]
seats = [0, 1]
`;
  const solved = wasm.solve_spot(toml, 2000, 0.02, 500, () => {});
  const meta = JSON.parse(solved.meta());
  console.log(`  meta: ${JSON.stringify(meta)}`);

  assert.equal(meta.payoff_unit, "cste", "an ICM solve must be tagged cste");
  assert.equal(meta.format_version, 3, "a tournament block raises the format version");
  assert.ok(meta.tournament, "meta must carry the structure the spot was scored against");
  assert.deepEqual(meta.tournament.payouts, [500, 300, 200]);
  assert.deepEqual(meta.tournament.stacks, [10, 18, 25, 6]);
  assert.deepEqual(meta.tournament.seats, [0, 1]);

  // gain is per player and sums to the headline NashConv.
  assert.equal(meta.gain.length, 2);
  assert.ok(meta.gain.every((g) => Number.isFinite(g) && g >= 0), `gain ${meta.gain}`);
  close(
    meta.gain[0] + meta.gain[1],
    meta.exploitability_chips,
    1e-4,
    "gain[0] + gain[1] vs NashConv"
  );
  ok(
    "meta tags the payoff unit and splits NashConv per player",
    `${meta.payoff_unit}, gain ${meta.gain[0].toFixed(6)} + ${meta.gain[1].toFixed(6)} = ` +
      `${meta.exploitability_chips.toFixed(6)} cste chips`
  );

  // The bubble-factor matrix: square, asymmetric where the stacks differ, above 1
  // for the two seats in the hand.
  const bf = meta.tournament.bubble_factors;
  const seats = meta.tournament.stacks.length;
  assert.equal(bf.length, seats);
  for (const row of bf) assert.equal(row.length, seats);
  for (let i = 0; i < seats; i += 1) assert.equal(bf[i][i], 1, `diagonal seat ${i}`);
  const [oopSeat, ipSeat] = meta.tournament.seats;
  assert.ok(bf[oopSeat][ipSeat] > 1, `OOP bubble factor ${bf[oopSeat][ipSeat]}`);
  assert.ok(bf[ipSeat][oopSeat] > 1, `IP bubble factor ${bf[ipSeat][oopSeat]}`);
  assert.ok(
    Math.abs(bf[oopSeat][ipSeat] - bf[ipSeat][oopSeat]) > 0.01,
    `covered and covering seats priced the flip alike: ${bf[oopSeat][ipSeat]} vs ${bf[ipSeat][oopSeat]}`
  );
  ok(
    "bubble_factors is a pairwise asymmetric matrix",
    `${seats}x${seats}, OOP ${bf[oopSeat][ipSeat].toFixed(4)} vs IP ${bf[ipSeat][oopSeat].toFixed(4)}`
  );

  // --- root-EV reconciliation under ICM ---
  const rootEvs = JSON.parse(solved.root_evs());
  console.log(`  root_evs: ${JSON.stringify(rootEvs)}`);
  for (const player of [0, 1]) {
    const evs = solved.combo_evs(0, player);
    const w = solved.combo_ev_weights(0, player);
    assert.equal(evs.length, w.length);
    let num = 0;
    let den = 0;
    let finite = 0;
    for (let i = 0; i < evs.length; i += 1) {
      assert.ok(Number.isFinite(evs[i]), `player ${player} combo ${i} ev ${evs[i]}`);
      finite += 1;
      num += w[i] * evs[i];
      den += w[i];
    }
    const mean = num / den;
    const delta = Math.abs(mean - rootEvs.zero_sum[player]);
    close(mean, rootEvs.zero_sum[player], 1e-4, `ICM player ${player} reach-weighted mean vs root_evs`);
    ok(
      `ICM combo_evs reconcile with root_evs.zero_sum[${player}]`,
      `${finite} combos, mean ${mean.toFixed(8)} vs ${rootEvs.zero_sum[player].toFixed(8)}, delta ${delta.toExponential(2)}`
    );
  }

  // Under ICM the two seats' pot-share EVs are absolute equities in CSTE chips, so
  // they do NOT sum to the starting pot the way a chip solve's do.
  const potShareSum = rootEvs.pot_share[0] + rootEvs.pot_share[1];
  assert.ok(
    Math.abs(potShareSum - 10.0) > 1.0,
    `ICM pot-share EVs summed to ${potShareSum}, which is the chip convention, not equity`
  );
  ok(
    "ICM pot-share EVs are absolute seat equity, not a pot split",
    `sum ${potShareSum.toFixed(4)} cste chips vs a 10.0 chip pot`
  );

  // The structure survives export/import.
  const reloaded = wasm.load_solution(solved.to_json());
  assert.equal(reloaded.meta(), solved.meta());
  ok("ICM solution round-trips through load_solution", `meta identical, ${solved.to_json().length} chars`);
}

console.log(`\nALL GREEN — ${checks} checks`);
