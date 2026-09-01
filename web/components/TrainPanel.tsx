"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cards, ComboCards } from "@/components/Card";
import SolvePanel from "@/components/SolvePanel";
import { actionColors, cellOf, comboFreqs, rangeFreqs } from "@/lib/grid";
import {
  CORRECT_PCT_POT,
  TIER_LABEL,
  flipHand,
  grade,
  gradeable,
  isClose,
  loadHistory,
  parseHand,
  pickUniform,
  pickWeighted,
  rollAction,
  rollD100,
  saveHistory,
  summarize,
  type Grade,
  type HandRecord,
  type Rng,
  type Tier,
} from "@/lib/trainer";
import type { SpotContext } from "@/lib/config";
import type { Combo, Meta, NodeAction, NodeInfo } from "@/lib/types";
import { PLAYER_NAMES } from "@/lib/types";
import type { SolutionHandle } from "@/lib/wasm";

/** Chance of stopping at a hero decision node instead of walking past it, so dealt spots
 *  spread over the whole tree instead of always being the first decision on the line. */
const STOP_AT_HERO = 0.45;
/** Fresh random lines tried before giving up on finding a dealable spot. */
const MAX_DEALS = 40;
/** Hard stop on one walk, so a malformed tree can never spin the UI. */
const MAX_STEPS = 60;

/** Verdict colour on paper. `TIER_COLOR` is a grid-fill ramp — its lightest bet red is the
 *  lowest-contrast pairing there is against bone — so the tiers read as semantic tokens here. */
const TIER_TEXT: Record<Tier, string> = {
  best: "text-ok",
  correct: "text-ok",
  inaccuracy: "text-warn",
  wrong: "text-err",
  blunder: "text-err",
};
/** The verdict word's ground: a block only at the two ends of the ramp. */
const TIER_BLOCK: Record<Tier, string> = {
  best: "bg-ok-bg",
  correct: "",
  inaccuracy: "",
  wrong: "bg-err-bg",
  blunder: "bg-err-bg",
};

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
    // The solution spells each combo in its own canonical order; the user's spelling
    // (or a combo carried from an earlier street) may be flipped.
    slot = combos.findIndex((c) => c.cards === cards || c.cards === flipHand(cards));
    if (slot < 0 || combos[slot].weight <= 0 || !gradeable(at(slot))) return null;
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
  /** Positions and modeled player profiles for the loaded spot; null for an opened file. */
  spotContext: SpotContext | null;
  /** Bundled instant spots, so training can start with zero setup. */
  samples: { file: string; name: string; detail: string }[];
  onLoadSample: (file: string, name: string) => void;
  /** A solve finished inside this tab's own setup panel; the parent adopts it. */
  onSolved: (json: string, wall: number, context: SpotContext) => void;
  /** Jump the inspector to a played hand's node and grid cell. */
  onReview: (node: number, cell: { row: number; col: number }) => void;
  /** Injected so the dealer is deterministic in a test; the app passes Math.random. */
  rng?: Rng;
}

export default function TrainPanel({
  handle,
  spotContext,
  samples,
  onLoadSample,
  onSolved,
  onReview,
  rng = Math.random,
}: Props) {
  const [seat, setSeat] = useState<"any" | "oop" | "ip">("any");
  const [closeOnly, setCloseOnly] = useState(false);
  /** Optional "train this exact hand" filter, e.g. "AhKd"; empty means deal randomly. */
  const [handText, setHandText] = useState("");
  /** The spot-setup panel, shown when nothing is loaded or on request for a new spot. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** Deal automatically as soon as the solution this tab just solved (or loaded) lands. */
  const autoDeal = useRef(false);
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

  /** `null` when the hand box is empty, a combo string when it parses, `false` on junk. */
  const fixedHand = handText.trim() === "" ? null : parseHand(handText) ?? false;

  const deal = useCallback(() => {
    if (!handle || fixedHand === false) return;
    setResult(null);
    for (let tries = 0; tries < MAX_DEALS; tries++) {
      const hero: 0 | 1 = seat === "any" ? (rng() < 0.5 ? 0 : 1) : seat === "oop" ? 0 : 1;
      const walk = walkToHero(handle, 0, hero, fixedHand, STOP_AT_HERO, rng, []);
      if (walk.kind !== "hero") continue;
      // A chosen hand overrides the close-decisions filter: the user asked for this
      // exact combo, not for whichever combos happen to mix here.
      const next = makeSpot(
        handle,
        walk.node,
        hero,
        walk.history,
        fixedHand ? false : closeOnly,
        rng,
        fixedHand,
      );
      if (next) {
        setDealt({ handle, spot: next, note: null });
        return;
      }
    }
    setDealt({
      handle,
      spot: null,
      note: fixedHand
        ? `${fixedHand} never reached a gradeable decision for that seat in ${MAX_DEALS} random lines. It may be outside the range, blocked by the board, or at zero weight.`
        : closeOnly
          ? `No close decision (top two actions within 1% of pot) turned up in ${MAX_DEALS} random lines. Turn the filter off, or load a spot with more mixing.`
          : `No gradeable spot for that seat in ${MAX_DEALS} random lines.`,
    });
  }, [handle, seat, closeOnly, rng, fixedHand]);

  // A solution just arrived that this tab asked for (its own solve, or a sample chosen
  // from the setup panel): start dealing without another click.
  useEffect(() => {
    if (handle && autoDeal.current) {
      autoDeal.current = false;
      setSetupOpen(false);
      deal();
    }
  }, [handle, deal]);

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
        `Hand over: ${walk.kind === "end" ? walk.text : `${spot.cards} has no defined EV at the next decision`}. ` +
        `Line: ${walk.history.join(" › ")}`,
    });
  };

  const clear = () => {
    setRows([]);
    saveHistory([]);
  };

  /** Starting stacks/pot from the solution itself, plus each range's width (share of all
   *  1326 combos, weight-summed) — an honest per-spot VPIP analogue computed at the root. */
  const spotInfo = useMemo(() => {
    if (!handle) return null;
    const meta = JSON.parse(handle.meta()) as Meta;
    const width = (p: 0 | 1) => {
      const cs = JSON.parse(handle.combos(0, p)) as Combo[];
      return cs.reduce((sum, c) => sum + c.weight, 0) / 1326;
    };
    return { meta, widths: [width(0), width(1)] as [number, number] };
  }, [handle]);

  const stats = useMemo(() => summarize(rows), [rows]);
  const listed = useMemo(
    () => (sortWorst ? [...rows].sort((a, b) => b.pctPot - a.pctPot) : rows),
    [rows, sortWorst],
  );

  return (
    <div className="train-shell">
      {/* ── Drill column ───────────────────────────────────────────────────────── */}
      <section className="flex min-h-0 flex-col bg-panel">
        <div className="bar">
          Train
          <span className="meta">
            {spot
              ? `node ${spot.node.id} · ${spot.node.street} · pot ${spot.node.pot.toFixed(2)}`
              : spotInfo
                ? `${spotInfo.meta.node_count.toLocaleString()} nodes loaded · ${stats.hands} graded`
                : "no spot loaded"}
          </span>
          {handle && (
            <span className="right">
              <button
                data-testid="train-new-spot"
                onClick={() => setSetupOpen((s) => !s)}
                className="btn"
                style={{ padding: "9px 10px", fontSize: 11 }}
              >
                {setupOpen ? "Close setup" : "New spot…"}
              </button>
            </span>
          )}
        </div>

        <div className="rule-b flex flex-wrap items-center gap-x-4 gap-y-2 bg-paper-2 px-3 py-2">
          <span className="flex items-center gap-2">
            <span className="label">hero</span>
            <span className="seg">
              {(
                [
                  ["any", "either"],
                  ["oop", "OOP"],
                  ["ip", "IP"],
                ] as const
              ).map(([id, text]) => (
                <button key={id} aria-pressed={seat === id} onClick={() => setSeat(id)}>
                  {text}
                </button>
              ))}
            </span>
          </span>

          <label className="flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={closeOnly} onChange={(e) => setCloseOnly(e.target.checked)} />
            close decisions only
            <span className="text-[11px] text-dim">top two actions within 1% of pot</span>
          </label>

          <label className="flex items-center gap-1.5 text-muted">
            <span className="label">hand</span>
            <input
              data-testid="train-hand"
              value={handText}
              onChange={(e) => setHandText(e.target.value)}
              placeholder="any, or AhKd"
              spellCheck={false}
              aria-invalid={fixedHand === false}
              aria-describedby={fixedHand === false ? "train-hand-error" : undefined}
              className={`num w-24 border-2 bg-raised px-2 py-1 text-text placeholder:text-dim ${
                fixedHand === false ? "border-err" : "border-ink"
              }`}
            />
            {fixedHand === false && (
              <span id="train-hand-error" className="text-[11px] text-err">
                two cards, e.g. AhKd
              </span>
            )}
          </label>

          <button
            data-testid="train-deal"
            disabled={!handle || fixedHand === false}
            onClick={deal}
            className="btn btn-primary ml-auto"
            style={{ height: 44, fontSize: 14, padding: "0 16px" }}
          >
            {spot ? "Deal another" : "Deal a hand"}
          </button>
        </div>

        {(!handle || setupOpen) && (
          <div className="rule-b">
            <div className="bar">
              {handle ? "Set up a new spot" : "Pick a spot to train"}
              <span className="meta">
                {samples.length} bundled spots · the trainer deals the moment one lands
              </span>
            </div>
            <div className="flex flex-wrap">
              {samples.map((s, i) => (
                <div
                  key={s.file}
                  className={`on-ink flex min-w-[240px] flex-1 flex-col ${i > 0 ? "rule-l" : ""}`}
                >
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div
                      className="uppercase text-text-inv"
                      style={{
                        font: "900 clamp(20px,1.6vw,28px)/1 var(--font-sans)",
                        letterSpacing: "-.03em",
                      }}
                    >
                      {s.name}
                    </div>
                    <div className="num text-[12px] text-dim-inv">{s.detail}</div>
                  </div>
                  <button
                    data-testid={`train-sample-${s.file}`}
                    onClick={() => {
                      autoDeal.current = true;
                      onLoadSample(s.file, s.name);
                    }}
                    title={s.detail}
                    className="btn h-11 w-full"
                    style={{ fontSize: 13 }}
                  >
                    Load →
                  </button>
                </div>
              ))}
            </div>
            <SolvePanel
              locks={[]}
              onRemoveLock={() => {}}
              onClearLocks={() => {}}
              onSolved={(json, wall, ctx) => {
                autoDeal.current = true;
                onSolved(json, wall, ctx);
              }}
            />
          </div>
        )}

        {note && (
          <p
            className="rule-b bg-accent px-3 py-2 uppercase text-ink"
            style={{ font: "800 11px/1.4 var(--font-sans)", letterSpacing: ".04em" }}
          >
            {note}
          </p>
        )}

        {handle && !spot && spotInfo && (
          <>
            <div className="rule-b flex flex-wrap">
              {(
                [
                  ["starting pot", spotInfo.meta.starting_pot.toFixed(2)],
                  ["effective stack", spotInfo.meta.effective_stack.toFixed(2)],
                  ["OOP range", `${(spotInfo.widths[0] * 100).toFixed(0)}%`],
                  ["IP range", `${(spotInfo.widths[1] * 100).toFixed(0)}%`],
                  ["decision nodes", spotInfo.meta.node_count.toLocaleString()],
                ] as const
              ).map(([label, value], i) => (
                <div key={label} className={`min-w-[130px] flex-1 px-3 py-3 ${i > 0 ? "rule-l" : ""}`}>
                  <div className="label">{label}</div>
                  <div className="fig fig-3 mt-1">{value}</div>
                </div>
              ))}
            </div>
            {/* Pre-deal poster: the drill area is never blank ground (Law 1/5). */}
            <button
              onClick={deal}
              disabled={fixedHand === false}
              className="on-ink flex min-h-0 flex-1 flex-col items-start justify-center gap-4 text-left"
              style={{ padding: "clamp(24px,3vw,56px)" }}
            >
              <span
                className="uppercase text-text-inv"
                style={{ font: "900 clamp(40px,5vw,96px)/0.92 var(--font-sans)", letterSpacing: "-.045em" }}
              >
                Deal a hand{" "}
                <span className="bg-accent text-[#101010]" style={{ padding: "0 .12em" }}>
                  →
                </span>
              </span>
              <span className="num text-[13px] text-dim-inv">
                you get a random combo at a random decision node on the solved tree · pick an
                action · graded in chips against the solve, instantly
              </span>
            </button>
          </>
        )}

        {spot && (
          <>
            <div className="rule-b flex flex-wrap items-center gap-x-4 gap-y-1 bg-paper-2 px-3 py-2">
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
              {spotInfo && (
                <span className="num text-dim">
                  started {spotInfo.meta.effective_stack.toFixed(1)} behind · pot{" "}
                  {spotInfo.meta.starting_pot.toFixed(1)}
                </span>
              )}
              <span className="num text-dim">
                {spot.node.street} · node {spot.node.id}
              </span>
            </div>

            <div
              data-testid="train-players"
              className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line-soft px-3 py-2"
            >
              {([0, 1] as const).map((p) => {
                const prof = spotContext?.[p === 0 ? "oop" : "ip"];
                const hasStats = !!prof && (prof.vpip !== "" || prof.pfr !== "");
                return (
                  <span key={p} className="flex items-baseline gap-2">
                    <span className={`label ${spot.hero === p ? "text-text" : "text-dim"}`}>
                      {prof?.pos || PLAYER_NAMES[p]}
                      {prof?.pos && prof.pos !== PLAYER_NAMES[p] ? ` (${PLAYER_NAMES[p]})` : ""}
                      {spot.hero === p ? " · you" : ""}
                    </span>
                    {spotInfo && (
                      <span className="num text-muted">
                        range {(spotInfo.widths[p] * 100).toFixed(0)}% of hands
                      </span>
                    )}
                    {hasStats && (
                      <span className="num text-dim" title="the player profile these ranges model">
                        {prof.vpip !== "" && `VPIP ${prof.vpip}`}
                        {prof.vpip !== "" && prof.pfr !== "" && " / "}
                        {prof.pfr !== "" && `PFR ${prof.pfr}`}
                      </span>
                    )}
                  </span>
                );
              })}
              {spotContext?.preflop && (
                <span className="text-[11px] text-dim">preflop: {spotContext.preflop}</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1 border-b border-line-soft px-3 py-2">
              <span className="label mr-1">line</span>
              {spot.history.length === 0 ? (
                <span className="num text-dim">start of the solved spot</span>
              ) : (
                spot.history.map((label, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-dim">›</span>}
                    <span className="num border-2 border-ink bg-raised px-1.5 py-0.5 text-[11px]">
                      {label}
                    </span>
                  </span>
                ))
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 px-3 py-3">
              <span className="label">you are {PLAYER_NAMES[spot.hero]} holding</span>
              <ComboCards cards={spot.cards} variant="stock" size={34} className="gap-1.5" />
            </div>

            <div
              className="flex flex-wrap gap-1.5 p-3"
              style={
                result === null
                  ? { outline: "3px solid var(--color-live)", outlineOffset: "-3px" }
                  : undefined
              }
            >
              {spot.actions.map((a, i) => (
                <button
                  key={i}
                  disabled={result !== null}
                  onClick={() => answer(i)}
                  className={`btn flex items-center gap-2 ${
                    result !== null && result.chosen !== i ? "opacity-40" : ""
                  }`}
                  style={
                    result?.chosen === i
                      ? { background: "var(--color-accent)", color: "var(--color-ink)" }
                      : undefined
                  }
                >
                  <span className="h-1 w-4 shrink-0" style={{ background: spot.colors[i] }} />
                  <span className="num">{a.text}</span>
                  {a.percent_of_pot != null && (
                    <span className="num text-dim">{a.percent_of_pot.toFixed(0)}%</span>
                  )}
                </button>
              ))}
            </div>

            {result && (
              <div className="rule-t p-3">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <span
                    className={`uppercase ${TIER_BLOCK[result.grade.tier]}`}
                    style={{
                      font: "900 30px/1 var(--font-sans)",
                      letterSpacing: "-.03em",
                      padding: TIER_BLOCK[result.grade.tier] ? "4px 10px" : 0,
                    }}
                  >
                    {TIER_LABEL[result.grade.tier]}
                  </span>
                  <div>
                    <div className="label">EV loss · chips</div>
                    <div
                      className={`fig fig-1 ${
                        result.grade.evLoss === 0
                          ? "text-ok"
                          : result.grade.pctPot < CORRECT_PCT_POT
                            ? "text-warn"
                            : "text-err"
                      }`}
                    >
                      {result.grade.evLoss.toFixed(3)}
                    </div>
                    <div className="num mt-1 text-[11px] text-muted">
                      {(result.grade.pctPot * 100).toFixed(2)}% of pot
                    </div>
                  </div>
                  <div>
                    <div className="label">solver plays it</div>
                    <div className="fig fig-2">{(result.grade.freq * 100).toFixed(1)}%</div>
                    <div className="num mt-1 text-[11px] text-muted">with this hand</div>
                  </div>
                </div>

                <div className="mt-3 grid gap-1">
                  <div className="grid grid-cols-[1fr_120px_84px_46px] gap-x-2 border-b-2 border-ink bg-paper-2 px-1.5 py-1">
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
                        className="grid h-[26px] grid-cols-[1fr_120px_84px_46px] items-center gap-x-2 px-1.5"
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="h-1 w-4 shrink-0" style={{ background: spot.colors[i] }} />
                          <span className="num">{a.text}</span>
                          {i === result.grade.bestAction && <span className="label text-ok">best EV</span>}
                          {i === result.chosen && <span className="label text-muted">you</span>}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-2.5 flex-1 overflow-hidden bg-paper-2"
                            style={{ outline: "1px solid var(--color-ink)", outlineOffset: "-1px" }}
                          >
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
                        <span className="num text-right">{rolled ? "◀" : ""}</span>
                      </div>
                    );
                  })}
                </div>

                <p className="num mt-2 text-[11px] text-muted">
                  Randomizer: rolled <span className="text-text">{result.roll}</span> of 100.{" "}
                  {rollAction(spot.freqs, result.roll) < 0
                    ? "The solver has no frequency here."
                    : `At the table, that picks ${
                        spot.actions[rollAction(spot.freqs, result.roll)].text
                      }.`}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={deal} className="btn">
                    Next hand
                  </button>
                  <button data-testid="train-continue" onClick={continueHand} className="btn">
                    Continue hand
                  </button>
                  <button onClick={() => onReview(spot.node.id, spot.cell)} className="btn">
                    Review in inspector
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Session scorecard ──────────────────────────────────────────────────── */}
      <section className="flex min-h-0 flex-col bg-panel">
        <div className="bar">
          Session
          <span className="meta">{rows.length} hands this session</span>
          <span className="right">
            <button onClick={clear} className="btn" style={{ padding: "9px 10px", fontSize: 11 }}>
              Clear
            </button>
          </span>
        </div>

        <div className="rule-b bg-paper-2 px-3 py-3">
          <div className="label">best or correct</div>
          <div className="fig fig-1 mt-1">{(stats.accuracy * 100).toFixed(0)}%</div>
          <div className="num mt-1 text-[11px] text-muted">
            {stats.correct} of {stats.hands} graded decisions
          </div>
        </div>

        <div className="rule-b flex">
          <div className="flex-1 px-3 py-2">
            <div className="label">hands played</div>
            <div className="num mt-1 text-[15px]">{stats.hands}</div>
          </div>
          <div className="rule-l flex-1 px-3 py-2">
            <div className="label">mean EV loss</div>
            <div className="num mt-1 text-[15px]">{(stats.avgLossPct * 100).toFixed(2)}%</div>
          </div>
        </div>

        <div className="border-t-2 border-ink bg-paper-2 px-3 py-2 text-[11px] text-muted">
          Grades are EV loss against the solve, not frequency matching: on a mixed node every
          action the solver is indifferent between costs nothing.
        </div>
      </section>

      {/* ── Hand history ───────────────────────────────────────────────────────── */}
      <section className="flex min-h-0 flex-col bg-panel">
        <div className="bar">
          Hand history
          <span className="meta">{listed.length} played</span>
          <span className="right">
            <button
              onClick={() => setSortWorst((s) => !s)}
              className="btn"
              style={{ padding: "9px 10px", fontSize: 11 }}
            >
              {sortWorst ? "Worst first" : "Most recent"}
            </button>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listed.length === 0 ? (
            <div className="px-3 py-3">
              <div className="label">0 hands graded</div>
              <p className="num mt-1 text-[11px] text-muted">
                every action you pick is scored on the chips it costs against the solve and lands
                here, worst first.
              </p>
            </div>
          ) : (
            listed.map((r, i) => (
              <button
                key={`${r.node}-${r.cards}-${i}`}
                onClick={() => onReview(r.node, { row: r.row, col: r.col })}
                title={`node ${r.node} · ${r.board} · ${r.action}`}
                className={`grid h-[28px] w-full grid-cols-[62px_minmax(0,1fr)_52px] items-center gap-x-2 px-2.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] ${
                  i % 2 === 1 ? "bg-paper-2" : ""
                }`}
                style={{ borderBottom: "1px solid rgba(16,16,16,.14)" }}
              >
                <ComboCards cards={r.cards} className="text-[13px]" />
                <span className={`num truncate text-[11px] ${TIER_TEXT[r.tier]}`}>
                  {TIER_LABEL[r.tier]}
                  <span className="ml-1.5 text-dim">{r.action}</span>
                </span>
                <span className="num text-right text-muted">{(r.pctPot * 100).toFixed(2)}%</span>
              </button>
            ))
          )}
        </div>

        <div className="border-t-2 border-ink bg-paper-2 px-3 py-2 text-[11px] text-muted">
          Clicking a hand opens that node and hand class in the inspector.
        </div>
      </section>
    </div>
  );
}
