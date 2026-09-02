"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cards, ComboCards } from "@/components/Card";
import SolvePanel from "@/components/SolvePanel";
import { cellOf, comboFreqs, hatched, rangeFreqs } from "@/lib/grid";
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
import { EMPTY_CONTEXT, PRESETS, toToml, WARN_BYTES, type SpotContext } from "@/lib/config";
import { randomBoard } from "@/lib/range";
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

/** Verdict colour. An action ink is a fill and never text, so a verdict word is set in a
 *  semantic token (ok / warn / err), never in the bet or check ink it grades. */
const TIER_TEXT: Record<Tier, string> = {
  best: "text-ok",
  correct: "text-ok",
  inaccuracy: "text-warn",
  wrong: "text-err",
  blunder: "text-err",
};
/** The verdict word's ground: a recessed block only at the two ends of the ramp. */
const TIER_BLOCK: Record<Tier, string> = {
  best: "bg-ok-bg",
  correct: "",
  inaccuracy: "",
  wrong: "bg-err-bg",
  blunder: "bg-err-bg",
};

/**
 * The three action inks. Inside one of these rectangles an ink is an ACTION; on a card
 * face the same three hues are SUITS. Never both in one rectangle. Check carries the 45
 * degree overprint so the mix reads in greyscale and without colour vision.
 */
const ACTION_INK: Record<string, string> = {
  fold: "var(--color-fold)",
  check: "var(--color-check)",
  call: "var(--color-check)",
};
const inkOf = (label: string) => ACTION_INK[label] ?? "var(--color-bet)";
/* Every fill below is painted with `backgroundColor`, never the `background`
   shorthand: an inline shorthand resets background-image and would erase the
   `.hatch` overprint that `hatched()` asks for. */

interface Spot {
  node: NodeInfo;
  hero: 0 | 1;
  actions: NodeAction[];
  /** Hero's dealt combo, e.g. `"AsKd"`. */
  cards: string;
  cell: { row: number; col: number };
  /** That combo's EV under each action, all defined (`makeSpot` guarantees it). */
  actionEvs: number[];
  /** The solved mix for that combo, hidden until the user has answered. */
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
 * *range-wide* solved frequencies: we do not know which hand the opponent holds, so
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
            ? `${PLAYER_NAMES[t.folder]} folds, pot ${t.pot.toFixed(2)} bb`
            : `showdown, pot ${(t?.pot ?? node.pot).toFixed(2)} bb`,
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
 * defined: a `NaN` action EV is not gradeable, so those hands are never dealt.
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
  // order exactly, the same invariant buildEvGrid relies on.
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
  /** A random-board solve in flight: what is being solved and how far along it is. */
  const [randoming, setRandoming] = useState<null | {
    board: string;
    story: string;
    iter: number;
    pct: number | null;
  }>(null);
  const solveWorker = useRef<Worker | null>(null);
  const solveId = useRef(1);
  useEffect(() => () => solveWorker.current?.terminate(), []);

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

  /** One request/response round trip against the trainer's own solve worker. */
  const ask = useCallback(
    (payload: Record<string, unknown>, onProgress?: (iter: number, pct: number) => void) =>
      new Promise<{ stats?: string; json?: string; wall?: number }>((resolve, reject) => {
        if (!solveWorker.current) {
          solveWorker.current = new Worker("/solve-worker.js", { type: "module" });
        }
        const w = solveWorker.current;
        const id = solveId.current++;
        const handler = (e: MessageEvent) => {
          const m = e.data;
          if (m.id !== id) return;
          if (m.kind === "progress") return onProgress?.(m.iter, m.pct);
          w.removeEventListener("message", handler);
          if (m.kind === "error") reject(new Error(m.message));
          else resolve(m);
        };
        w.addEventListener("message", handler);
        w.addEventListener("error", (e) => reject(new Error(e.message || "worker failed")), {
          once: true,
        });
        w.postMessage({ id, ...payload });
      }),
    [],
  );

  /**
   * A fresh random spot: a random 100bb preflop scenario from the story presets, a
   * random turn board, solved right here, then dealt the moment it converges. Boards
   * whose tree busts the memory guard are redrawn rather than solved.
   */
  const randomSpot = useCallback(async () => {
    if (randoming) return;
    const pool = PRESETS.filter((p) => ["btn-bb", "co-btn", "sb-bb", "bb-3bet"].includes(p.id));
    const preset = pool[Math.floor(rng() * pool.length)] ?? pool[0];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const board = randomBoard(4, rng);
        const form = { ...structuredClone(preset.form), board };
        const toml = toToml(form);
        setRandoming({
          board,
          story: form.context?.preflop ?? "",
          iter: 0,
          pct: null,
        });
        const stats = JSON.parse((await ask({ kind: "stats", toml })).stats!) as {
          total_bytes: number;
        };
        if (stats.total_bytes > WARN_BYTES) continue;
        const res = await ask(
          {
            kind: "solve",
            toml,
            maxIterations: Math.max(1, Number(form.max_iterations)),
            targetPct: Number(form.target_pct),
            reportEvery: Math.max(1, Number(form.report_every)),
          },
          (iter, pct) => setRandoming((s) => (s ? { ...s, iter, pct } : s)),
        );
        autoDeal.current = true;
        setRandoming(null);
        onSolved(res.json!, res.wall ?? 0, form.context ?? EMPTY_CONTEXT);
        return;
      }
      setRandoming(null);
      setDealt({
        handle: handle!,
        spot: null,
        note: "Three random boards in a row busted the solver's memory guard. Try again.",
      });
    } catch (e) {
      setRandoming(null);
      setDealt({
        handle: handle!,
        spot: null,
        note: `Random spot failed to solve: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [randoming, rng, ask, onSolved, handle]);

  /** The unit `evLoss` is denominated in. Read from the solution rather than from
   *  `spotInfo` below, which is declared after this and would drag the whole spot memo
   *  into every graded hand. */
  const payoffUnit = useMemo(
    () => (handle ? ((JSON.parse(handle.meta()) as Meta).payoff_unit ?? "chips") : "chips"),
    [handle],
  );

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
      // The unit `evLoss` is in. Under a tournament solve the trainer is grading CSTE
      // chips, not big blinds, and a row that does not say so is a row that reads as bb.
      unit: payoffUnit,
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
   *  1326 combos, weight-summed), an honest per-spot VPIP analogue computed at the root. */
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
      <section className="flex min-h-0 flex-col bg-panel" data-tour="train-drill">
        <div className="bar">
          Train
          <span className="meta">
            {spot
              ? `node ${spot.node.id} · ${spot.node.street} · pot ${spot.node.pot.toFixed(2)} bb`
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

        <div
          data-tour="train-filters"
          className="rule-b flex flex-wrap items-center gap-x-4 gap-y-2 bg-paper-2 px-3 py-2"
        >
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
              className={`num w-36 border bg-raised px-2 py-1 text-text placeholder:text-dim ${
                fixedHand === false ? "border-err" : "border-line-strong"
              }`}
            />
            {fixedHand === false && (
              <span id="train-hand-error" className="text-[11px] text-err">
                two cards, e.g. AhKd
              </span>
            )}
          </label>

          <span className="ml-auto flex items-center gap-2">
            <button
              data-testid="train-deal"
              disabled={!handle || fixedHand === false || !!randoming}
              onClick={deal}
              className="btn"
              style={{ height: 44, fontSize: 12, padding: "0 12px" }}
              title="Deal another hand on the board that is already solved"
            >
              Same board
            </button>
            <button
              data-testid="train-random"
              disabled={fixedHand === false || !!randoming}
              onClick={() => void randomSpot()}
              className="btn btn-primary"
              style={{ height: 44, fontSize: 14, padding: "0 16px" }}
              title="Solve a fresh random board in a random 100bb scenario, then deal"
            >
              {randoming ? "Solving…" : "Random spot →"}
            </button>
          </span>
        </div>

        {randoming && (
          <div
            className="rule-b on-ink relative flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
            role="status"
          >
            <span className="label">solving</span>
            <Cards cards={randoming.board.split(" ")} className="text-[14px] font-semibold" />
            <span className="num text-[12px] text-dim-inv">{randoming.story}</span>
            <span className="num ml-auto text-[12px] text-text-inv">
              {randoming.pct == null
                ? "building tree…"
                : `iter ${randoming.iter} · ${randoming.pct.toFixed(2)}% of pot`}
            </span>
            <span className="slide-rule" />
          </div>
        )}

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
                      className="text-text"
                      style={{
                        font: "800 clamp(20px,1.6vw,28px)/1.05 var(--font-sans)",
                        letterSpacing: "-.02em",
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
            className="rule-b bg-accent px-3 py-2 text-accent-ink"
            style={{ font: "600 12.5px/1.45 var(--font-sans)" }}
          >
            {note}
          </p>
        )}

        {handle && !spot && spotInfo && (
          <>
            <div className="rule-b flex flex-wrap">
              {(
                [
                  ["starting pot", `${spotInfo.meta.starting_pot.toFixed(1)} bb`],
                  ["effective stack", `${spotInfo.meta.effective_stack.toFixed(1)} bb`],
                  ["OOP range", `${(spotInfo.widths[0] * 100).toFixed(0)}%`],
                  ["IP range", `${(spotInfo.widths[1] * 100).toFixed(0)}%`],
                  ["decision nodes", spotInfo.meta.node_count.toLocaleString()],
                ] as const
              ).map(([label, value], i) => (
                /* justify-end: below ~440px "effective stack" wraps to two lines while
                   its neighbours stay on one, which pushed 97.5 bb 12px below 5.5 bb and
                   27%. The cells already stretch to the row height, so hanging the pair
                   from the bottom puts every figure on one baseline. No-op where nothing
                   wraps. */
                <div
                  key={label}
                  className={`flex min-w-[130px] flex-1 flex-col justify-end px-3 py-3 ${i > 0 ? "rule-l" : ""}`}
                >
                  <div className="label">{label}</div>
                  <div className="fig fig-3 mt-1">{value}</div>
                </div>
              ))}
            </div>
            {/* Pre-deal poster: the drill area is never blank ground (Law 1/5). */}
            <div className="on-ink flex min-h-0 flex-1 flex-col items-start justify-center gap-4 text-left" style={{ padding: "clamp(24px,3vw,56px)" }}>
              <button
                onClick={() => void randomSpot()}
                disabled={fixedHand === false || !!randoming}
                className="text-left text-text"
                style={{ font: "800 clamp(40px,5vw,96px)/0.95 var(--font-sans)", letterSpacing: "-.03em", textWrap: "balance" }}
              >
                {randoming ? "Solving…" : "Random spot"}{" "}
                <span className="bg-accent text-accent-ink" style={{ padding: "0 .12em" }}>
                  →
                </span>
              </button>
              <span className="max-w-[68ch] text-[13px] text-dim-inv">
                A random board in a random 100bb scenario, solved on this page in a few seconds.
                You get a random combo at a decision node, you pick an action, and it is graded in
                big blinds against the solve, instantly, or in chip-scaled tournament equity
                (CSTE) on a tournament solve.
              </span>
              <button
                onClick={deal}
                disabled={fixedHand === false || !!randoming}
                className="btn"
                style={{ padding: "10px 16px", fontSize: 13 }}
              >
                Or deal on the loaded board
              </button>
            </div>
          </>
        )}

        {spot && (
          <>
            <div className="rule-b flex flex-wrap items-center gap-x-4 gap-y-1 bg-paper-2 px-3 py-2">
              <Cards cards={spot.node.board} className="text-[15px] font-semibold" />
              <span className="num text-muted">
                pot <span className="text-text">{spot.node.pot.toFixed(2)} bb</span>
              </span>
              <span className="num text-muted">
                stacks{" "}
                <span className="text-text">
                  {spot.node.stacks[0].toFixed(2)} / {spot.node.stacks[1].toFixed(2)} bb
                </span>
              </span>
              {spotInfo && (
                <span className="num text-dim">
                  started {spotInfo.meta.effective_stack.toFixed(1)}bb behind · pot{" "}
                  {spotInfo.meta.starting_pot.toFixed(1)}bb
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
                    <span className="num border border-line bg-raised px-1.5 py-0.5 text-[11px]">
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
              data-tour="train-actions"
              className="flex flex-wrap gap-1.5 p-3"
              style={
                result === null
                  ? { outline: "2px solid var(--color-live)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              {/* Each answer is the same printed object as a grid cell: a caption strip
                  over its action ink. The ink is a fill, so every label keeps stock white
                  on the raised ground at 15.7:1. The answer taken is knocked out with the
                  2px inset stock-white outline, never a colour change. */}
              {spot.actions.map((a, i) => (
                <button
                  key={i}
                  disabled={result !== null}
                  onClick={() => answer(i)}
                  className="flex min-w-[112px] flex-col"
                  style={{
                    border: "var(--rule) solid var(--color-line)",
                    background: "var(--color-raised)",
                    cursor: result === null ? "pointer" : "default",
                    ...(result?.chosen === i
                      ? { outline: "2px solid var(--color-live)", outlineOffset: "-2px" }
                      : null),
                  }}
                >
                  <span className="flex flex-1 items-baseline gap-2 px-2.5 py-2">
                    <span className="num text-text">{a.text}</span>
                    {a.percent_of_pot != null && (
                      <span className="num text-dim">{a.percent_of_pot.toFixed(0)}%</span>
                    )}
                  </span>
                  <span
                    className={`block h-[14px] w-full ${hatched(a.label) ? "hatch" : ""}`}
                    style={{ backgroundColor: inkOf(a.label) }}
                  />
                </button>
              ))}
            </div>

            {result && (
              <div className="rule-t p-3">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <span
                    className={TIER_BLOCK[result.grade.tier]}
                    style={{
                      font: "800 30px/1 var(--font-sans)",
                      letterSpacing: "-.025em",
                      padding: TIER_BLOCK[result.grade.tier] ? "4px 10px" : 0,
                    }}
                  >
                    {TIER_LABEL[result.grade.tier]}
                  </span>
                  <div>
                    <div className="label">EV loss · {payoffUnit === "cste" ? "cste" : "bb"}</div>
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
                  <div className="rule-b grid grid-cols-[1fr_120px_84px_46px] gap-x-2 bg-paper-2 px-1.5 py-1">
                    <span className="label">solver mix for this hand</span>
                    <span className="label">frequency</span>
                    <span className="label text-right">
                      EV ({payoffUnit === "cste" ? "cste" : "bb"})
                    </span>
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
                          <span
                            className={`h-[11px] w-[11px] shrink-0 ${hatched(a.label) ? "hatch" : ""}`}
                            style={{ backgroundColor: inkOf(a.label) }}
                          />
                          <span className="num">{a.text}</span>
                          {i === result.grade.bestAction && <span className="label text-ok">best EV</span>}
                          {i === result.chosen && <span className="label text-muted">you</span>}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="h-2.5 flex-1 overflow-hidden bg-ink-2">
                            <span
                              className={`block h-full ${hatched(a.label) ? "hatch" : ""}`}
                              style={{
                                width: `${spot.freqs[i] * 100}%`,
                                backgroundColor: inkOf(a.label),
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

                <p className="mt-2 text-[11px] text-muted">
                  Randomizer: rolled <span className="num text-text">{result.roll}</span> of 100.{" "}
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
          {/* A dash, not 0%, before anything is graded: this app says elsewhere that a
              dash means no data and that zero is a different statement. */}
          <div className="fig fig-1 mt-1">
            {stats.hands === 0 ? "–" : `${(stats.accuracy * 100).toFixed(0)}%`}
          </div>
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
            <div className="num mt-1 text-[15px]">
              {stats.hands === 0 ? "–" : `${(stats.avgLossPct * 100).toFixed(2)}%`}
            </div>
          </div>
        </div>

        <div className="rule-t bg-paper-2 px-3 py-2 text-[11px] text-muted">
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
              <p className="mt-1 text-[11px] text-muted">
                Every action you pick is scored on the{" "}
                {payoffUnit === "cste" ? "CSTE tournament chips" : "big blinds"} it costs against
                the solve and lands here, worst first.
              </p>
            </div>
          ) : (
            listed.map((r, i) => (
              <button
                key={`${r.node}-${r.cards}-${i}`}
                onClick={() => onReview(r.node, { row: r.row, col: r.col })}
                title={`node ${r.node} · ${r.board} · ${r.action}`}
                className={`grid h-[28px] w-full grid-cols-[62px_minmax(0,1fr)_52px] items-center gap-x-2 px-2.5 text-left hover:bg-ink-2 ${
                  i % 2 === 1 ? "bg-paper-2" : ""
                }`}
                style={{ borderBottom: "var(--rule) solid var(--color-line-soft)" }}
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

        <div className="rule-t bg-paper-2 px-3 py-2 text-[11px] text-muted">
          Clicking a hand opens that node and hand class in the inspector.
        </div>
      </section>
    </div>
  );
}
