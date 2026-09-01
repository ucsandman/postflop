// Regression test for solve-form session persistence and node locking (web/lib/config.ts).
// Pure TS, no framework: `node lib/config.test.ts` from web/ (Node 22.6+ strips
// erasable TS syntax natively, no build step needed). The last section boots the real
// wasm module, so it needs `npm run sync-wasm` to have run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_FORM, PRESETS, actionToken, findPresetId, loadForm, saveForm, spotKey, toToml } from "./config.ts";
import type { NodeLock, SolveForm } from "./config.ts";
import type { Meta, NodeInfo } from "./types.ts";

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

  /** All of every combo's weight on action 0 — the shape `strategy(id)` hands out. */
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

  // 2. A node one action down, named by the line `actionToken`/`lineOf` build — the
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
  //    line resolves to a node with the same player, action count and combo count — the
  //    engine's own checks all pass and it freezes a strategy solved for another board.
  //    That is the failure the spot stamp exists to stop, so prove it happens first.
  const otherBoard: SolveForm = { ...structuredClone(form), board: "Ks 7d 2c 8h 6d" };
  const wouldHaveSilentlyLocked = solve(toToml(otherBoard, [{ ...rootLock, spot: spotKey(otherBoard) }]));
  assert.equal(
    (JSON.parse(wouldHaveSilentlyLocked.node(0)) as NodeInfo).locked,
    true,
    "the edited board accepts the stale line/shape — nothing downstream would have caught it",
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

console.log("PASS: config.test.ts");
