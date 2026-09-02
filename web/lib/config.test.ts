// Regression test for solve-form session persistence and node locking (web/lib/config.ts).
// Pure TS, no framework: `node lib/config.test.ts` from web/ (Node 22.6+ strips
// erasable TS syntax natively, no build step needed). The last section boots the real
// wasm module, so it needs `npm run sync-wasm` to have run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_FORM,
  ICM_WORK_BUDGET,
  PAYOUT_PRESETS,
  PRESETS,
  actionToken,
  checkTournament,
  findPresetId,
  icmWorkEstimate,
  loadForm,
  saveForm,
  seedTournament,
  spotKey,
  toToml,
} from "./config.ts";
import type { NodeLock, SolveForm, TournamentForm } from "./config.ts";
import { rangeFreqs } from "./grid.ts";
import type { Combo, Meta, NodeInfo } from "./types.ts";

// --- in-memory localStorage stand-in -------------------------------------------------
// Plain Node has no `localStorage`; saveForm/loadForm's own try/catch already has to
// tolerate that (that's the private-browsing / disabled-storage case), so this fake is
// only here to exercise the round trip, not to work around a missing global.
class FakeStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  clear() {
    this.store.clear();
  }
}
(globalThis as { localStorage?: FakeStorage }).localStorage = new FakeStorage();
const storage = (globalThis as unknown as { localStorage: FakeStorage }).localStorage;

// No stored form yet -> null, not a crash.
storage.clear();
assert.equal(loadForm(), null, "nothing saved yet -> null");

// Round trip: save the default form, read it back unchanged.
saveForm(DEFAULT_FORM);
assert.deepEqual(loadForm(), DEFAULT_FORM, "round trip must be lossless");

// Corrupted JSON -> null, not a throw.
storage.setItem("solver-web.solveForm", "{not json");
assert.equal(loadForm(), null, "corrupted JSON -> null");

// Valid JSON but missing the shape a form needs (e.g. an older schema) -> null.
storage.setItem("solver-web.solveForm", JSON.stringify({ board: "Qs Jh 2h" }));
assert.equal(loadForm(), null, "structurally incomplete blob -> null");

// A sizings grid missing one seat/street cell is still rejected, not half-accepted.
{
  const broken = structuredClone(DEFAULT_FORM) as unknown as { sizings: { oop: { turn?: unknown } } };
  delete broken.sizings.oop.turn;
  storage.setItem("solver-web.solveForm", JSON.stringify(broken));
  assert.equal(loadForm(), null, "missing sizing cell -> null, not a partially-valid form");
}

// saveForm never throws even when the underlying storage does (quota, disabled, etc.).
{
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  (globalThis as { localStorage: unknown }).localStorage = throwing;
  assert.doesNotThrow(() => saveForm(DEFAULT_FORM), "a throwing setItem must not escape saveForm");
  (globalThis as { localStorage: unknown }).localStorage = storage;
}

// loadForm never throws when storage itself is missing (e.g. no DOM at all).
{
  delete (globalThis as { localStorage?: unknown }).localStorage;
  assert.doesNotThrow(() => loadForm(), "no localStorage global must not escape loadForm");
  (globalThis as { localStorage: unknown }).localStorage = storage;
}

// findPresetId: matches an untouched preset, "" once it diverges even slightly.
assert.equal(findPresetId(PRESETS[0].form), PRESETS[0].id, "untouched preset must match its own id");
const edited: SolveForm = { ...structuredClone(PRESETS[0].form), board: "2s 3s 4s" };
assert.equal(findPresetId(edited), "", "a hand-edited form matches no preset");

// --- Node locks, round-tripped through the real engine --------------------------------
// The point of this section is that nothing here is mocked: `toToml` writes `[[locks]]`,
// the wasm build parses it, and the solution that comes back is asked whether the node is
// actually frozen at the distribution we sent. A locked strategy that came back *solved*
// would be indistinguishable from a working lock in a pure test, so the frozen
// distribution is deliberately one no solver would produce: 100% of the first action.
{
  const glue = await import("../vendor/solver-wasm/solver_wasm.js");
  await glue.default({
    module_or_path: readFileSync(new URL("../public/wasm/solver_wasm_bg.wasm", import.meta.url)),
  });

  // Tiny on purpose: 12 nodes, 23 combos, solves in milliseconds.
  const form = PRESETS.find((p) => p.id === "river-drill")!.form;
  const ITERS = 200;
  const solve = (toml: string) => glue.solve_spot(toml, ITERS, 0.01, ITERS, () => {});

  const plain = solve(toToml(form));
  const root = JSON.parse(plain.node(0)) as NodeInfo;
  assert.equal(root.kind, "decision", "the river drill's root must be a decision node");
  assert.equal(root.locked, false, "an ordinary solve locks nothing");
  assert.deepEqual((JSON.parse(plain.meta()) as Meta).locks, [], "no locks -> empty meta list");

  /** All of every combo's weight on action 0, the shape `strategy(id)` hands out. */
  const allOnFirstAction = (handle: typeof plain, id: number) => {
    const numActions = handle.num_actions(id);
    const combos = handle.strategy(id).length / numActions;
    const v = new Array(numActions * combos).fill(0);
    v.fill(1, 0, combos);
    return v;
  };

  // 1. The root, locked at `line = ""`.
  const rootPlayer = root.player!;
  const frozen = allOnFirstAction(plain, 0);
  assert.notDeepEqual(
    Array.from(plain.strategy(0)),
    frozen,
    "the unlocked solve must NOT already play the frozen strategy, or this proves nothing",
  );
  // The Inspector stamps a lock with `spotKey(meta())`; the Solve panel checks it against
  // `spotKey(form)`. Those two have to agree for any lock to ever be solvable, so assert
  // it rather than assume the normalization lines up.
  const spot = spotKey(JSON.parse(plain.meta()) as Meta);
  assert.equal(spot, spotKey(form), "spotKey(meta) and spotKey(form) must agree for the same spot");

  const rootLock: NodeLock = { line: "", spot, player: rootPlayer, strategy: frozen, label: "root" };
  const lockedRoot = solve(toToml(form, [rootLock]));
  assert.deepEqual(
    (JSON.parse(lockedRoot.meta()) as Meta).locks,
    [{ node: 0, player: rootPlayer, line: "" }],
    "meta().locks must name the frozen node",
  );
  assert.equal((JSON.parse(lockedRoot.node(0)) as NodeInfo).locked, true, "node(0).locked");
  assert.deepEqual(
    Array.from(lockedRoot.strategy(0)),
    frozen,
    "a locked node must report exactly the distribution that was locked in",
  );

  // 2. A node one action down, named by the line `actionToken`/`lineOf` build, the
  //    format check for the breadcrumb tokens the Inspector's lock button emits.
  const stepped = root.actions!
    .map((a) => ({ a, child: JSON.parse(plain.node(a.child)) as NodeInfo }))
    .find(({ child }) => child.kind === "decision");
  assert.ok(stepped, "the river drill must offer at least one action reaching a decision node");
  const line = actionToken(stepped.a);
  const nestedLock: NodeLock = {
    line,
    spot,
    player: stepped.child.player!,
    strategy: allOnFirstAction(plain, stepped.a.child),
    label: line,
  };
  const lockedChild = solve(toToml(form, [nestedLock]));
  assert.deepEqual(
    (JSON.parse(lockedChild.meta()) as Meta).locks,
    [{ node: stepped.a.child, player: stepped.child.player, line }],
    `line ${JSON.stringify(line)} must resolve to the node it was read from`,
  );
  assert.deepEqual(
    Array.from(lockedChild.strategy(stepped.a.child)),
    nestedLock.strategy,
    "the nested locked node must report the frozen distribution",
  );

  // 3. A line that names no node fails loudly rather than solving something else.
  assert.throws(
    () => solve(toToml(form, [{ ...rootLock, line: "bet:999" }])),
    /999/,
    "an unresolvable lock line must be an error",
  );

  // 4. A lock captured on a DIFFERENT spot is refused before the engine ever sees it.
  //    The 6d river below touches none of the ranges (KK/A4s/A5s vs TT/JJ), so the same
  //    line resolves to a node with the same player, action count and combo count, the
  //    engine's own checks all pass and it freezes a strategy solved for another board.
  //    That is the failure the spot stamp exists to stop, so prove it happens first.
  const otherBoard: SolveForm = { ...structuredClone(form), board: "Ks 7d 2c 8h 6d" };
  const wouldHaveSilentlyLocked = solve(toToml(otherBoard, [{ ...rootLock, spot: spotKey(otherBoard) }]));
  assert.equal(
    (JSON.parse(wouldHaveSilentlyLocked.node(0)) as NodeInfo).locked,
    true,
    "the edited board accepts the stale line/shape, nothing downstream would have caught it",
  );
  wouldHaveSilentlyLocked.free();
  assert.throws(
    () => toToml(otherBoard, [rootLock]),
    /different spot/,
    "a lock stamped with another spot must be refused, not emitted",
  );

  for (const h of [plain, lockedRoot, lockedChild]) h.free();
  console.log(`  locks: root + ${JSON.stringify(line)} both froze, ${frozen.length} values each`);
}

// --- Tournament ICM, against the real engine -----------------------------------------
// Nothing mocked here either: `toToml` writes `[tournament]`, the wasm build parses it,
// and the solution that comes back is asked what unit it was scored in and what the
// structure did to the strategy. A pure test could not tell an emitted-but-ignored block
// from a working one.
{
  const glue = await import("../vendor/solver-wasm/solver_wasm.js");
  const form = PRESETS.find((p) => p.id === "river-drill")!.form;
  const ITERS = 400;
  // targetPct 0 so the run never stops early: the pinned frequencies below are the
  // strategy after exactly ITERS iterations, not after whichever report first crossed
  // a threshold.
  const solve = (f: SolveForm, locks: NodeLock[] = []) =>
    glue.solve_spot(toToml(f, locks), ITERS, 0.0, ITERS, () => {});

  /** Six seats, the hand between seat 0 (short, 20 behind = the form's effective stack)
   *  and seat 1 (covering, 40). Seat 0 is the one a bubble punishes. */
  const structure = (payouts: number[]): TournamentForm => ({
    payouts: payouts.join(", "),
    stacks: "20, 40, 10, 10, 30, 60",
    seats: [0, 1],
  });
  const withStructure = (payouts: number[]): SolveForm => ({
    ...structuredClone(form),
    tournament: structure(payouts),
  });

  // The seeded block is solvable as seeded: the engine rejects a table where neither
  // in-hand seat holds exactly `effective_stack`, so a default that violates rule 5
  // would greet every first-time user with a validation error.
  const seeded: SolveForm = { ...structuredClone(form), tournament: seedTournament(form.effective_stack) };
  const seededSolve = solve(seeded);
  assert.equal(
    (JSON.parse(seededSolve.meta()) as Meta).payoff_unit,
    "cste",
    "seedTournament must produce a block the engine accepts",
  );
  seededSolve.free();

  // Every shipped preset is a structure the engine accepts on that same table.
  for (const preset of PAYOUT_PRESETS) {
    const h = solve(withStructure(preset.payouts));
    assert.equal(
      (JSON.parse(h.meta()) as Meta).payoff_unit,
      "cste",
      `payout preset "${preset.id}" must solve`,
    );
    h.free();
  }

  // 1. The unit tag, the per-player gain and the structure all come back on `meta()`,
  //    and a chip solve of the same spot carries none of it.
  const satellite = withStructure(PAYOUT_PRESETS.find((p) => p.id === "satellite")!.payouts);
  const topHeavy = withStructure(PAYOUT_PRESETS.find((p) => p.id === "top-heavy")!.payouts);
  const chipSolve = solve(form);
  const satSolve = solve(satellite);
  const topSolve = solve(topHeavy);

  const chipMeta = JSON.parse(chipSolve.meta()) as Meta;
  const satMeta = JSON.parse(satSolve.meta()) as Meta;
  assert.equal(chipMeta.payoff_unit, "chips", "a chip solve is tagged chips");
  assert.equal(chipMeta.tournament ?? null, null, "a chip solve carries no structure");
  assert.equal(satMeta.payoff_unit, "cste", "a tournament solve is tagged cste");
  assert.ok(satMeta.tournament, "a tournament solve carries its structure");
  assert.equal(satMeta.tournament!.stacks.length, 6, "six seats round-tripped");
  assert.equal(satMeta.tournament!.payouts.length, 5, "five places round-tripped");
  assert.deepEqual(satMeta.tournament!.seats, [0, 1], "seats round-tripped");
  assert.ok(
    Math.abs(satMeta.gain![0] + satMeta.gain![1] - satMeta.exploitability_chips) < 1e-6,
    `gain must sum to NashConv: ${satMeta.gain![0]} + ${satMeta.gain![1]} vs ${satMeta.exploitability_chips}`,
  );

  // 2. The bubble-factor matrix is asymmetric on a covered/covering pair. A symmetric
  //    implementation, or a chipEV-shaped one, all 1.0, is the whole failure mode.
  const bf = satMeta.tournament!.bubble_factors;
  assert.equal(bf.length, 6, "the matrix is square over the seats");
  for (let i = 0; i < bf.length; i++) {
    assert.equal(bf[i][i], 1, "a seat against itself risks nothing");
  }
  assert.ok(
    bf[0][1]! > bf[1][0]! + 0.5,
    `the covered seat must pay a steeper bubble factor than the covering one: ${bf[0][1]} vs ${bf[1][0]}`,
  );
  assert.ok(bf[0][1]! > 1 && bf[1][0]! > 1, "both seats are on a bubble, so both exceed 1");

  // 3. The strategy actually moves, and moves with the shape of the ladder. IP's
  //    response to the root bet is the canonical ICM lesson: facing the same bet with
  //    the same range, a covering stack folds more as the ladder flattens toward a
  //    satellite. Constants are measured at ITERS=400 on this build.
  const ipFoldFreq = (h: ReturnType<typeof solve>) => {
    const root = JSON.parse(h.node(0)) as NodeInfo;
    const bet = root.actions!.find((a) => a.label === "bet")!;
    const child = JSON.parse(h.node(bet.child)) as NodeInfo;
    assert.equal(child.player, 1, "the node after OOP's bet is IP's decision");
    const combos = JSON.parse(h.combos(child.id, 1)) as Combo[];
    const f = rangeFreqs(combos, h.strategy(child.id), h.num_actions(child.id));
    const fold = child.actions!.findIndex((a) => a.label === "fold");
    return { id: child.id, fold: f[fold], combos: combos.length };
  };
  const chipFold = ipFoldFreq(chipSolve);
  const satFold = ipFoldFreq(satSolve);
  const topFold = ipFoldFreq(topSolve);
  assert.equal(chipFold.id, satFold.id, "the ICM twin has the identical tree, so the same node id");
  for (const [name, got, want] of [
    ["chipEV", chipFold.fold, 0.500006],
    ["satellite", satFold.fold, 0.717869],
    ["top-heavy", topFold.fold, 0.540098],
  ] as [string, number, number][]) {
    assert.ok(
      Math.abs(got - want) < 1e-4,
      `${name} IP fold frequency: got ${got.toFixed(6)}, committed ${want} (tol 1e-4)`,
    );
  }
  assert.ok(
    satFold.fold > chipFold.fold + 0.1,
    `a satellite must fold strictly more than chipEV: ${satFold.fold} vs ${chipFold.fold}`,
  );
  assert.ok(
    satFold.fold > topFold.fold && topFold.fold > chipFold.fold,
    `fold frequency must rise with the steepness of the bubble: chip ${chipFold.fold} < top-heavy ${topFold.fold} < satellite ${satFold.fold}`,
  );

  // 4. `spotKey(meta) === spotKey(form)` on a tournament spot. The Inspector stamps a
  //    lock with the first and the Solve panel checks it against the second; if the
  //    tournament block were normalized differently on the two sides no lock taken on a
  //    tournament spot would ever be solvable.
  assert.equal(
    spotKey(satMeta),
    spotKey(satellite),
    "spotKey(meta) and spotKey(form) must agree on a tournament spot",
  );

  // 5. THE POINT OF PUTTING THE STRUCTURE IN THE KEY. Two solves that differ only in the
  //    payouts build byte-identical trees, same node ids, same acting player, same
  //    action and combo counts, so every one of the engine's own lock checks passes and
  //    it would happily freeze a strategy solved for a different prize ladder. Prove
  //    that first, then prove `toToml` refuses it.
  const rootPlayer = (JSON.parse(satSolve.node(0)) as NodeInfo).player!;
  const numActions = satSolve.num_actions(0);
  const combos = satSolve.strategy(0).length / numActions;
  const frozen = new Array(numActions * combos).fill(0);
  frozen.fill(1, 0, combos);
  assert.equal(topSolve.num_actions(0), numActions, "the two ladders build the same node 0");
  assert.equal(
    topSolve.strategy(0).length / topSolve.num_actions(0),
    combos,
    "...with the same combo count, which is every check the engine itself can make",
  );
  const satLock: NodeLock = {
    line: "",
    spot: spotKey(satellite),
    player: rootPlayer,
    strategy: frozen,
    label: "root",
  };
  const wouldHaveSilentlyLocked = solve(topHeavy, [{ ...satLock, spot: spotKey(topHeavy) }]);
  assert.equal(
    (JSON.parse(wouldHaveSilentlyLocked.node(0)) as NodeInfo).locked,
    true,
    "the other ladder accepts the stale line/shape, nothing downstream would have caught it",
  );
  wouldHaveSilentlyLocked.free();
  assert.throws(
    () => toToml(topHeavy, [satLock]),
    /different spot/,
    "a lock captured under another payout structure must be refused, not emitted",
  );
  // The same lock against its own structure is fine, so the refusal above is about the
  // payouts and not about tournament locks in general.
  assert.doesNotThrow(() => toToml(satellite, [satLock]), "a lock on its own structure emits");
  // Only the payouts differ between these two; stacks and seats are identical.
  assert.notEqual(spotKey(satellite), spotKey(topHeavy), "payouts alone must change the key");
  assert.notEqual(spotKey(satellite), spotKey(form), "a chip spot and an ICM spot are not the same spot");

  for (const h of [chipSolve, satSolve, topSolve]) h.free();
  console.log(
    `  icm: ${PAYOUT_PRESETS.length} payout presets solved · 6 seats, 5 paid · ` +
      `BF(0,1) ${bf[0][1]!.toFixed(4)} vs BF(1,0) ${bf[1][0]!.toFixed(4)} · ` +
      `IP fold ${(chipFold.fold * 100).toFixed(2)}% chipEV -> ${(topFold.fold * 100).toFixed(2)}% top-heavy ` +
      `-> ${(satFold.fold * 100).toFixed(2)}% satellite over ${satFold.combos} combos at ${ITERS} iters`,
  );
}

// --- isSolveForm and the saved-form round trip, with a block -------------------------
{
  storage.clear();
  (globalThis as { localStorage: unknown }).localStorage = storage;
  const withBlock: SolveForm = {
    ...structuredClone(DEFAULT_FORM),
    tournament: seedTournament(DEFAULT_FORM.effective_stack),
  };
  saveForm(withBlock);
  assert.deepEqual(loadForm(), withBlock, "a form with a tournament block round trips");

  // A form saved before tournaments existed has no block and must still load.
  const { tournament: _none, ...legacy } = withBlock;
  storage.setItem("solver-web.solveForm", JSON.stringify(legacy));
  assert.deepEqual(loadForm(), legacy, "a pre-tournament form still loads");

  // A block that IS there and is malformed is a corrupted blob, not a chip solve.
  for (const [why, bad] of [
    ["payouts is not a string", { ...seedTournament("100"), payouts: [50, 30] }],
    ["stacks is not a string", { ...seedTournament("100"), stacks: 100 }],
    ["seats is not a pair", { ...seedTournament("100"), seats: [0] }],
    ["seats are not indices", { ...seedTournament("100"), seats: [0, -1] }],
    ["the block is null", null],
  ] as [string, unknown][]) {
    storage.setItem("solver-web.solveForm", JSON.stringify({ ...withBlock, tournament: bad }));
    assert.equal(loadForm(), null, `${why} -> null, not a half-valid form`);
  }
  console.log("  tournament form: round trip + legacy form + 5 malformed blocks rejected");
}

// --- checkTournament: the live check the panel shows, and the two rules that exist
// --- only because their loose form shipped a wrong answer ---------------------------
{
  const at = (over: Partial<TournamentForm>): TournamentForm => ({
    payouts: "500, 300, 200",
    stacks: "100, 250, 150, 120",
    seats: [0, 1],
    ...over,
  });
  assert.equal(checkTournament(at({}), "100"), null, "the seeded shape is accepted");

  // A ladder longer than the LIVE field, not longer than the seat list: three seats
  // still hold chips, so a fourth prize can never be awarded. `icm::equity` would hand
  // it to nobody while the CSTE scale still divides by the whole pool, and every payoff
  // would come out short by that ratio. The seat-count form of this rule accepted it.
  const busted = at({ stacks: "100, 250, 150, 0", payouts: "500, 400, 300, 200" });
  const bustedErr = checkTournament(busted, "100");
  assert.match(
    String(bustedErr),
    /4 places paid but only 3 of the 4 seats/,
    `a ladder past the live field must be rejected, got ${bustedErr}`,
  );
  assert.equal(
    checkTournament(at({ stacks: "100, 250, 150, 0" }), "100"),
    null,
    "three prizes over three live seats is still fine",
  );

  // Cost, not correctness: 16 seats paying 6 passes every other rule and takes 1.32 s
  // in the engine to price the bubble-factor matrix -- on the browser's main thread.
  const heavy = at({
    stacks: ["100", "250", ...Array(14).fill("150")].join(", "),
    payouts: "600, 500, 400, 300, 200, 100",
  });
  const heavyErr = checkTournament(heavy, "100");
  assert.match(
    String(heavyErr),
    /past the .* budget/,
    `16 seats paying 6 must be rejected on cost, got ${heavyErr}`,
  );
  // ...and a real ten-handed final table paying every place still fits.
  const ten = at({
    stacks: ["100", "250", ...Array(8).fill("150")].join(", "),
    payouts: Array.from({ length: 10 }, (_, i) => 100 - i * 5).join(", "),
  });
  assert.equal(checkTournament(ten, "100"), null, "10 seats paying 10 is inside the budget");

  // The estimate is the engine's, exactly: sum_{k<places} C(alive,k) * seats * (2n^2+1).
  assert.equal(icmWorkEstimate(4, 3, 3), (1 + 3 + 3) * 4 * (2 * 16 + 1), "4 seats, 3 alive, 3 paid");
  assert.equal(icmWorkEstimate(10, 10, 10), 1023 * 10 * 201, "10 seats paying 10");
  console.log(
    `  checkTournament: 6 cases · budget ${ICM_WORK_BUDGET.toExponential(0)} · ` +
      `10x10 costs ${icmWorkEstimate(10, 10, 10).toExponential(3)}, ` +
      `16x6 costs ${icmWorkEstimate(16, 16, 6).toExponential(3)}`,
  );
}

console.log("PASS: config.test.ts");
