"use client";

import { useCallback, useMemo, useState } from "react";
import { Cards, ComboCards } from "@/components/Card";
import { actionColors, cellOf, comboFreqs, rangeFreqs } from "@/lib/grid";
import {
  TIER_COLOR,
  TIER_LABEL,
  grade,
  gradeable,
  isClose,
  loadHistory,
  pickUniform,
  pickWeighted,
  rollAction,
  rollD100,
  saveHistory,
  summarize,
  type Grade,
  type HandRecord,
  type Rng,
} from "@/lib/trainer";
import type { Combo, NodeAction, NodeInfo } from "@/lib/types";
import { PLAYER_NAMES } from "@/lib/types";
import type { SolutionHandle } from "@/lib/wasm";

/** Chance of stopping at a hero decision node instead of walking past it, so dealt spots
 *  spread over the whole tree instead of always being the first decision on the line. */
const STOP_AT_HERO = 0.45;
/** Fresh random lines tried before giving up on finding a dealable spot. */
const MAX_DEALS = 40;
/** Hard stop on one walk, so a malformed tree can never spin the UI. */
const MAX_STEPS = 60;

interface Spot {
  node: NodeInfo;
  hero: 0 | 1;
  actions: NodeAction[];
  colors: string[];
  /** Hero's dealt combo, e.g. `"AsKd"`. */
  cards: string;
  cell: { row: number; col: number };
  /** That combo's EV under each action, all defined (`makeSpot` guarantees it). */
  actionEvs: number[];
  /** The solved mix for that combo — hidden until the user has answered. */
  freqs: number[];
  /** Breadcrumb labels from the root down to this node. */
  history: string[];
}

type Walk =
  | { kind: "hero"; node: NodeInfo; history: string[] }
  | { kind: "end"; text: string; history: string[] };

/**
 * Play a line down from `startId` until the hero has a decision to make.
 *
 * Chance nodes deal uniformly at random from the live cards (minus the hero's own two,
 * once they are known). Every action node in between is sampled from that player's
 * *range-wide* solved frequencies — we do not know which hand the opponent holds, so
 * their whole range at that node is the honest distribution to sample from.
 *
 * `stopP` is the chance of stopping at a hero decision rather than sampling hero's own
 * action and walking on; pass 1 to stop at the first one.
 */
function walkToHero(
  handle: SolutionHandle,
  startId: number,
  hero: 0 | 1,
  heroCards: string | null,
  stopP: number,
  rng: Rng,
  history: string[],
): Walk {
  let id = startId;
  const trail = [...history];
  for (let step = 0; step < MAX_STEPS; step++) {
    const node = JSON.parse(handle.node(id)) as NodeInfo;

    if (node.kind === "terminal") {
      const t = node.terminal;
      return {
        kind: "end",
        history: trail,
        text:
          t?.kind === "fold"
            ? `${PLAYER_NAMES[t.folder]} folds, pot ${t.pot.toFixed(2)}`
            : `showdown, pot ${(t?.pot ?? node.pot).toFixed(2)}`,
      };
    }

    if (node.kind === "chance") {
      const live = (node.valid_cards ?? []).filter(
        (v) => !heroCards || (v.card !== heroCards.slice(0, 2) && v.card !== heroCards.slice(2, 4)),
      );
      const pick = pickUniform(live.length, rng);
      if (pick < 0) return { kind: "end", text: "no card left to deal", history: trail };
      trail.push(live[pick].card);
      id = live[pick].child;
      continue;
    }

    const actions = node.actions ?? [];
    if (actions.length === 0) return { kind: "end", text: "no actions at this node", history: trail };
    const player = node.player ?? 0;
    if (player === hero && rng() < stopP) return { kind: "hero", node, history: trail };

    const combos = JSON.parse(handle.combos(id, player)) as Combo[];
    const freqs = rangeFreqs(combos, handle.strategy(id), actions.length);
    const a = pickWeighted(freqs, rng);
    const taken = actions[a < 0 ? 0 : a];
    trail.push(`${PLAYER_NAMES[player]} ${taken.text}`);
    id = taken.child;
  }
  return { kind: "end", text: "line ran deeper than the trainer follows", history: trail };
}

/**
 * Deal one hand at a hero decision node, or `null` when nothing there can be graded.
 *
 * `cards` fixes the hand (continuing a hand hero is already holding); otherwise the combo
 * is drawn weighted by its reach at this node, among combos whose every action EV is
 * defined — a `NaN` action EV is not gradeable, so those hands are never dealt.
 */
function makeSpot(
  handle: SolutionHandle,
  node: NodeInfo,
  hero: 0 | 1,
  history: string[],
  closeOnly: boolean,
  rng: Rng,
  cards: string | null,
): Spot | null {
  const actions = node.actions ?? [];
  if (actions.length === 0) return null;
  const combos = JSON.parse(handle.combos(node.id, hero)) as Combo[];
  if (combos.length === 0) return null;

  // Action edges deal no card, so every child shares this node's live-combo list and slot
  // order exactly — the same invariant buildEvGrid relies on.
  const evs = actions.map((a) => handle.combo_evs(a.child, hero));
  const at = (slot: number) => evs.map((e) => e[slot]);

  let slot: number;
  if (cards !== null) {
    slot = combos.findIndex((c) => c.cards === cards);
    if (slot < 0 || !gradeable(at(slot))) return null;
  } else {
    const weights = combos.map((c, i) => {
      const row = at(i);
      if (c.weight <= 0 || !gradeable(row)) return 0;
      if (closeOnly && !isClose(row, node.pot)) return 0;
      return c.weight;
    });
    slot = pickWeighted(weights, rng);
    if (slot < 0) return null;
  }

  return {
    node,
    hero,
    actions,
    colors: actionColors(actions),
    cards: combos[slot].cards,
    cell: cellOf(combos[slot].cards),
    actionEvs: at(slot),
    freqs: comboFreqs(handle.strategy(node.id), actions.length, combos.length, slot),
    history,
  };
}

interface Props {
  handle: SolutionHandle | null;
  /** Jump the inspector to a played hand's node and grid cell. */
  onReview: (node: number, cell: { row: number; col: number }) => void;
  /** Injected so the dealer is deterministic in a test; the app passes Math.random. */
  rng?: Rng;
}

export default function TrainPanel({ handle, onReview, rng = Math.random }: Props) {
  const [seat, setSeat] = useState<"any" | "oop" | "ip">("any");
  const [closeOnly, setCloseOnly] = useState(false);
  /**
   * The dealt hand, tagged with the solution it came from: loading another solution frees
   * the old handle and invalidates every node id in the spot, so anything dealt from it is
   * stale and simply stops being shown. The tag is compared by identity and never called,
   * so it can safely outlive the handle it points at.
   */
  const [dealt, setDealt] = useState<{
    handle: SolutionHandle;
    spot: Spot | null;
    note: string | null;
  } | null>(null);
  const [result, setResult] = useState<{ chosen: number; grade: Grade; roll: number } | null>(null);
  const [rows, setRows] = useState<HandRecord[]>(loadHistory);
  const [sortWorst, setSortWorst] = useState(true);

  const current = dealt && dealt.handle === handle ? dealt : null;
  const spot = current?.spot ?? null;
  const note = current?.note ?? null;

  const deal = useCallback(() => {
    if (!handle) return;
    setResult(null);
    for (let tries = 0; tries < MAX_DEALS; tries++) {
      const hero: 0 | 1 = seat === "any" ? (rng() < 0.5 ? 0 : 1) : seat === "oop" ? 0 : 1;
      const walk = walkToHero(handle, 0, hero, null, STOP_AT_HERO, rng, []);
      if (walk.kind !== "hero") continue;
      const next = makeSpot(handle, walk.node, hero, walk.history, closeOnly, rng, null);
      if (next) {
        setDealt({ handle, spot: next, note: null });
        return;
      }
    }
    setDealt({
      handle,
      spot: null,
      note: closeOnly
        ? `No close decision (top two actions within 1% of pot) turned up in ${MAX_DEALS} random lines. Turn the filter off, or load a spot with more mixing.`
        : `No gradeable spot for that seat in ${MAX_DEALS} random lines.`,
    });
  }, [handle, seat, closeOnly, rng]);

  const answer = (chosen: number) => {
    if (!spot || result) return;
    const g = grade(spot.actionEvs, spot.freqs, chosen, spot.node.pot);
    setResult({ chosen, grade: g, roll: rollD100(rng) });
    const rec: HandRecord = {
      node: spot.node.id,
      row: spot.cell.row,
      col: spot.cell.col,
      cards: spot.cards,
      board: spot.node.board.join(" "),
      action: spot.actions[chosen].text,
      tier: g.tier,
      evLoss: g.evLoss,
      pctPot: g.pctPot,
      freq: g.freq,
    };
    setRows((prev) => {
      const next = [rec, ...prev];
      saveHistory(next);
      return next;
    });
  };

  const continueHand = () => {
    if (!handle || !spot || !result) return;
    const taken = spot.actions[result.chosen];
    const history = [...spot.history, `${PLAYER_NAMES[spot.hero]} ${taken.text}`];
    const walk = walkToHero(handle, taken.child, spot.hero, spot.cards, 1, rng, history);
    setResult(null);
    if (walk.kind === "hero") {
      const next = makeSpot(handle, walk.node, spot.hero, walk.history, false, rng, spot.cards);
      if (next) {
        setDealt({ handle, spot: next, note: null });
        return;
      }
    }
    setDealt({
      handle,
      spot: null,
      note:
        `Hand over — ${walk.kind === "end" ? walk.text : `${spot.cards} has no defined EV at the next decision`}. ` +
        `Line: ${walk.history.join(" › ")}`,
    });
  };

  const clear = () => {
    setRows([]);
    saveHistory([]);
  };

  const stats = useMemo(() => summarize(rows), [rows]);
  const listed = useMemo(
    () => (sortWorst ? [...rows].sort((a, b) => b.pctPot - a.pctPot) : rows),
    [rows, sortWorst],
  );

  return (
    <main className="flex flex-1 flex-col gap-3 p-3">
      <section className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="label">hero</span>
          <div className="flex gap-px overflow-hidden rounded border border-line">
            {(
              [
                ["any", "either"],
                ["oop", "OOP"],
                ["ip", "IP"],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                onClick={() => setSeat(id)}
                className={`px-2 py-0.5 ${
                  seat === id ? "bg-accent font-semibold text-ink" : "bg-raised text-muted hover:text-text"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={closeOnly} onChange={(e) => setCloseOnly(e.target.checked)} />
          close decisions only
          <span className="text-[11px] text-dim">top two actions within 1% of pot</span>
        </label>

        <button
          data-testid="train-deal"
          disabled={!handle}
          onClick={deal}
          className="ml-auto rounded bg-accent px-3.5 py-1.5 font-semibold text-ink hover:bg-[#efbc60] disabled:opacity-40"
        >
          {spot ? "Deal another" : "Deal a hand"}
        </button>
      </section>

      {!handle ? (
        <div className="panel flex items-center justify-center px-8 py-12 text-dim">
          Load a solution first — the trainer deals from the solved tree, it does not solve.
        </div>
      ) : (
        <div className="grid flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="panel flex flex-col overflow-hidden">
            {note && (
              <p className="border-b border-line bg-[#1c1608] px-3 py-2 text-accent">{note}</p>
            )}

            {!spot ? (
              <div className="flex flex-1 items-center justify-center px-8 py-12 text-dim">
                Deal a hand: you get the board, the pot and the line — not the strategy. Pick an
                action and it is graded on the chips it costs against the solve.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2">
                  <Cards cards={spot.node.board} className="text-[15px] font-semibold" />
                  <span className="num text-muted">
                    pot <span className="text-text">{spot.node.pot.toFixed(2)}</span>
                  </span>
                  <span className="num text-muted">
                    stacks{" "}
                    <span className="text-text">
                      {spot.node.stacks[0].toFixed(2)} / {spot.node.stacks[1].toFixed(2)}
                    </span>
                  </span>
                  <span className="num text-dim">
                    {spot.node.street} · node {spot.node.id}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1 border-b border-line-soft px-3 py-2">
                  <span className="label mr-1">line</span>
                  {spot.history.length === 0 ? (
                    <span className="num text-dim">start of the solved spot</span>
                  ) : (
                    spot.history.map((label, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-dim">›</span>}
                        <span className="num rounded border border-line bg-raised px-1.5 py-0.5 text-[11px]">
                          {label}
                        </span>
                      </span>
                    ))
                  )}
                </div>

                <div className="flex flex-wrap items-baseline gap-3 px-3 py-3">
                  <span className="label">you are {PLAYER_NAMES[spot.hero]} holding</span>
                  <ComboCards cards={spot.cards} className="text-xl font-semibold" />
                </div>

                <div className="flex flex-wrap gap-1.5 px-3 pb-3">
                  {spot.actions.map((a, i) => (
                    <button
                      key={i}
                      disabled={result !== null}
                      onClick={() => answer(i)}
                      className={`flex items-center gap-2 rounded border px-2.5 py-1.5 ${
                        result?.chosen === i
                          ? "border-accent bg-[#1c1608]"
                          : "border-line bg-raised hover:border-accent-dim"
                      } ${result !== null && result.chosen !== i ? "opacity-40" : ""}`}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ background: spot.colors[i] }}
                      />
                      <span className="num">{a.text}</span>
                      {a.percent_of_pot != null && (
                        <span className="num text-dim">{a.percent_of_pot.toFixed(0)}%</span>
                      )}
                    </button>
                  ))}
                </div>

                {result && (
                  <div className="border-t border-line px-3 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span
                        className="rounded px-2 py-0.5 font-semibold text-ink"
                        style={{ background: TIER_COLOR[result.grade.tier] }}
                      >
                        {TIER_LABEL[result.grade.tier]}
                      </span>
                      <span className="num text-muted">
                        EV loss{" "}
                        <span className="text-text">{result.grade.evLoss.toFixed(3)} chips</span> ·{" "}
                        <span className="text-text">{(result.grade.pctPot * 100).toFixed(2)}%</span>{" "}
                        of pot
                      </span>
                      <span className="num text-muted">
                        solver plays it{" "}
                        <span className="text-text">{(result.grade.freq * 100).toFixed(1)}%</span> with
                        this hand
                      </span>
                    </div>

                    <div className="mt-2.5 grid gap-1">
                      <div className="grid grid-cols-[1fr_120px_84px_46px] gap-x-2 text-[11px]">
                        <span className="label">solver mix for this hand</span>
                        <span className="label">frequency</span>
                        <span className="label text-right">EV (chips)</span>
                        <span className="label text-right">d100</span>
                      </div>
                      {spot.actions.map((a, i) => {
                        const rolled = rollAction(spot.freqs, result.roll) === i;
                        return (
                          <div
                            key={i}
                            className="grid grid-cols-[1fr_120px_84px_46px] items-center gap-x-2"
                          >
                            <span className="flex items-center gap-1.5">
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                                style={{ background: spot.colors[i] }}
                              />
                              <span className="num">{a.text}</span>
                              {i === result.grade.bestAction && (
                                <span className="text-[11px] text-accent">best EV</span>
                              )}
                              {i === result.chosen && (
                                <span className="text-[11px] text-muted">you</span>
                              )}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="h-2 flex-1 overflow-hidden rounded-sm bg-[#0a0e15]">
                                <span
                                  className="block h-full"
                                  style={{
                                    width: `${spot.freqs[i] * 100}%`,
                                    background: spot.colors[i],
                                  }}
                                />
                              </span>
                              <span className="num w-10 text-right text-muted">
                                {(spot.freqs[i] * 100).toFixed(1)}%
                              </span>
                            </span>
                            <span className="num text-right">{spot.actionEvs[i].toFixed(3)}</span>
                            <span className="num text-right text-accent">{rolled ? "◀" : ""}</span>
                          </div>
                        );
                      })}
                    </div>

                    <p className="mt-2 text-[11px] text-dim">
                      Randomizer: rolled{" "}
                      <span className="num text-muted">{result.roll}</span> of 100 —{" "}
                      {rollAction(spot.freqs, result.roll) < 0
                        ? "the solver has no frequency here."
                        : `at the table that picks ${
                            spot.actions[rollAction(spot.freqs, result.roll)].text
                          }.`}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={deal}
                        className="rounded bg-accent px-3 py-1.5 font-semibold text-ink hover:bg-[#efbc60]"
                      >
                        Next hand
                      </button>
                      <button
                        data-testid="train-continue"
                        onClick={continueHand}
                        className="rounded border border-line bg-raised px-3 py-1.5 hover:border-accent-dim"
                      >
                        Continue hand
                      </button>
                      <button
                        onClick={() => onReview(spot.node.id, spot.cell)}
                        className="rounded border border-line bg-raised px-3 py-1.5 hover:border-accent-dim"
                      >
                        Review in inspector
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="panel flex h-fit flex-col overflow-hidden">
            <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <span className="font-semibold">Session</span>
              <button onClick={clear} className="text-[11px] text-dim hover:text-text">
                clear
              </button>
            </div>

            <div className="grid grid-cols-3 gap-x-2 border-b border-line-soft px-3 py-2">
              <Stat label="hands" value={String(stats.hands)} />
              <Stat label="best/correct" value={`${(stats.accuracy * 100).toFixed(0)}%`} />
              <Stat label="avg EV loss" value={`${(stats.avgLossPct * 100).toFixed(2)}%`} />
            </div>

            <div className="flex items-baseline justify-between border-b border-line-soft px-3 py-1.5">
              <span className="label">played hands</span>
              <button
                onClick={() => setSortWorst((s) => !s)}
                className="text-[11px] text-dim hover:text-text"
              >
                sort: {sortWorst ? "worst first" : "most recent"}
              </button>
            </div>

            <div className="max-h-[420px] overflow-y-auto">
              {listed.length === 0 ? (
                <p className="px-3 py-4 text-dim">Nothing played yet.</p>
              ) : (
                listed.map((r, i) => (
                  <button
                    key={`${r.node}-${r.cards}-${i}`}
                    onClick={() => onReview(r.node, { row: r.row, col: r.col })}
                    title={`node ${r.node} · ${r.board} · ${r.action}`}
                    className="grid w-full grid-cols-[64px_1fr_58px] items-center gap-x-2 border-b border-line-soft/60 px-3 py-1 text-left hover:bg-raised"
                  >
                    <ComboCards cards={r.cards} className="text-[13px]" />
                    <span className="num truncate text-[11px]" style={{ color: TIER_COLOR[r.tier] }}>
                      {TIER_LABEL[r.tier]}
                      <span className="ml-1.5 text-dim">{r.action}</span>
                    </span>
                    <span className="num text-right text-muted">
                      {(r.pctPot * 100).toFixed(2)}%
                    </span>
                  </button>
                ))
              )}
            </div>

            <p className="border-t border-line px-3 py-2 text-[11px] text-dim">
              Grades are EV loss against the solve, not frequency matching: on a mixed node every
              action the solver is indifferent between costs nothing. Clicking a hand opens that
              node and hand class in the inspector.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label mb-0.5">{label}</div>
      <div className="num text-base font-semibold text-accent">{value}</div>
    </div>
  );
}
