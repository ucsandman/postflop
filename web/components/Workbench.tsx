"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BlockerPanel from "@/components/BlockerPanel";
import ComboPanel from "@/components/ComboPanel";
import RangeGrid from "@/components/RangeGrid";
import SolvePanel from "@/components/SolvePanel";
import TrainPanel from "@/components/TrainPanel";
import TreeNav, { BoardStrip, RunoutSelector } from "@/components/TreeNav";
import Card, { Cards } from "@/components/Card";
import Help from "@/components/Help";
import {
  Cell,
  CellEv,
  RunoutHotness,
  actionColors,
  buildEvGrid,
  buildGrid,
  buildRunoutHotness,
  cellLabel,
  rangeFreqs,
} from "@/lib/grid";
import { PRESETS, lineOf, spotKey, type NodeLock, type SpotContext } from "@/lib/config";
import type { Combo, Meta, NodeAction, NodeInfo, PathStep, RootEvs } from "@/lib/types";
import { PLAYER_NAMES } from "@/lib/types";
import { loadWasm, type SolutionHandle } from "@/lib/wasm";

type Tab = "inspect" | "train" | "solve" | "help";

/** Everything the inspector needs about the current node, read once per node change. */
type View =
  | { kind: "other"; node: NodeInfo }
  | {
      kind: "decision";
      node: NodeInfo;
      actions: NodeAction[];
      player: 0 | 1;
      combos: Combo[];
      strategy: Float32Array;
      evs: Float32Array;
      numActions: number;
      colors: string[];
      cells: Cell[];
      evCells: CellEv[];
      actionEvs: Float32Array[];
      oppCells: Cell[];
      oppCombos: Combo[];
      freqs: number[];
      /** Opponent's own next decision node, for the blocker panel; null if none is reachable. */
      oppActionNode: NodeInfo | null;
      oppActionStrategy: Float32Array | null;
      oppActionColors: string[];
    };

/**
 * Which player's EV the runout hotness overlay tracks: whoever acts first once the
 * card in question is dealt, found by walking down the first live child (all runouts
 * under one chance node share the same structure). Falls back to OOP for an all-in
 * chain that deals straight to showdown with no decision node in between.
 */
function findHeroPlayer(handle: SolutionHandle, startNodeId: number): 0 | 1 {
  let cur = JSON.parse(handle.node(startNodeId)) as NodeInfo;
  while (cur.kind === "chance" && cur.valid_cards && cur.valid_cards.length > 0) {
    cur = JSON.parse(handle.node(cur.valid_cards[0].child)) as NodeInfo;
  }
  return cur.kind === "decision" ? (cur.player ?? 0) : 0;
}

/** True at ≥1900px, where the inspector shows the strategy grid and the EV/regret
 *  grid side by side and the 3-way mode toggle is retired. */
function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1900px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

const SAMPLES = [
  {
    file: "fixture-turn.json",
    name: "Turn spot",
    detail: "Qs Jh 2h 8c · BTN vs BB single-raised · 100bb",
    board: ["Qs", "Jh", "2h", "8c"],
    // The bundled fixtures were solved from these presets, so the presets' table
    // context (positions, modeled profiles) is the fixtures' context too.
    context: PRESETS.find((p) => p.id === "turn-fixture")?.form.context ?? null,
  },
  {
    file: "fixture-river.json",
    name: "River spot",
    detail: "Ks 7d 2c 8h 3d · polarisation drill · 5 decision nodes",
    board: ["Ks", "7d", "2c", "8h", "3d"],
    context: PRESETS.find((p) => p.id === "river-drill")?.form.context ?? null,
  },
];

export default function Workbench() {
  const [handle, setHandle] = useState<SolutionHandle | null>(null);
  const [source, setSource] = useState<string>("");
  /** Table context of the loaded spot — positions and modeled player profiles. Known for
   *  samples and browser solves; `null` for an opened file, which carries no story. */
  const [spotContext, setSpotContext] = useState<SpotContext | null>(null);
  const [nodeId, setNodeId] = useState(0);
  const [path, setPath] = useState<PathStep[]>([]);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "solve" || t === "help" || t === "train" ? t : "inspect";
  });
  const [gridMode, setGridMode] = useState<"strategy" | "ev" | "regret">(() => {
    const m = new URLSearchParams(window.location.search).get("mode");
    return m === "ev" || m === "regret" ? m : "strategy";
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [booted, setBooted] = useState(false);
  // Client-only component (window is read in initializers above), so the boot
  // script's dataset.theme is readable here without an effect.
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light",
  );
  const wide = useWide();
  /**
   * Nodes the next solve should freeze. Session state, not part of the persisted solve
   * form: a lock is a whole node's strategy (numActions x combos floats) captured from a
   * solution that a page reload no longer has open.
   */
  const [locks, setLocks] = useState<NodeLock[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The handle currently owned by this component, so it can be freed exactly once. */
  const live = useRef<SolutionHandle | null>(null);
  /** Only the first solution load consults the URL; every later load resets to root
   *  the way it always has (loading a different solution mid-session isn't a restore). */
  const restoredFromUrl = useRef(false);
  // Snapshot the URL exactly once, in an effect rather than during render (refs can't be
  // read or written while rendering) and before the sync effect below gets a chance to
  // rewrite it — a bookmarked deep link (?node=42&combo=3,5) has to survive being read by
  // adopt() even though that effect will have already replaced the address bar by then.
  const initialParams = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    initialParams.current = new URLSearchParams(window.location.search);
  }, []);

  const setThemeAndPersist = (t: "light" | "dark") => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("pf-theme", t);
    } catch {}
  };

  const adopt = useCallback((json: string, label: string, keepTab = false) => {
    setError(null);
    setLoading(true);
    return loadWasm()
      .then((wasm) => {
        // Structure-guard + strategy-width validation happen here, not on a re-solve.
        const next = wasm.load_solution(json);
        // Free the old handle OUTSIDE the state updater. A `setState` updater has to be
        // pure — React replays it (StrictMode double-invoke, render restarts), and a
        // second `free()` on the same pointer traps with "null pointer passed to rust".
        const previous = live.current;
        live.current = next;
        setHandle(next);
        previous?.free();
        setSource(label);

        let initNode = 0;
        let initSelected: { row: number; col: number } | null = null;
        if (!restoredFromUrl.current) {
          restoredFromUrl.current = true;
          const params = initialParams.current ?? new URLSearchParams();
          const rawNode = params.get("node");
          if (rawNode !== null) {
            const n = Number(rawNode);
            // Guard against a solution that doesn't contain the referenced node (a
            // different sample/file than the one the link was made from) -- fall back
            // to root silently rather than let a stale id reach handle.node().
            if (Number.isInteger(n) && n >= 0 && n < next.node_count) initNode = n;
          }
          const combo = params.get("combo")?.match(/^(\d+),(\d+)$/);
          if (combo) {
            const row = Number(combo[1]);
            const col = Number(combo[2]);
            if (row < 13 && col < 13) initSelected = { row, col };
          }
        }
        setNodeId(initNode);
        setPath([]);
        setSelected(initSelected);
        if (!keepTab) setTab("inspect");
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  const loadSample = useCallback(
    async (file: string, name: string, keepTab = false) => {
      setError(null);
      setLoading(true);
      try {
        const res = await fetch(`/fixtures/${file}`);
        if (!res.ok) throw new Error(`could not fetch ${file}: HTTP ${res.status}`);
        await adopt(await res.text(), name, keepTab);
        setSpotContext(SAMPLES.find((s) => s.file === file)?.context ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    },
    [adopt],
  );

  // Auto-load the turn fixture on mount: the screen boots into real solver output
  // instead of an empty void. keepTab: a `?tab=solve` deep link must not be stolen.
  useEffect(() => {
    // Boot fetch on mount; loadSample's setState calls run in the async continuation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSample("fixture-turn.json", "Turn spot", true).finally(() => setBooted(true));
  }, [loadSample]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    await adopt(await f.text(), f.name);
    setSpotContext(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const exportJson = () => {
    if (!handle) return;
    const blob = new Blob([handle.to_json()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (source.replace(/\.json$/i, "") || "solution") + "-export.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const meta = useMemo<Meta | null>(
    () => (handle ? (JSON.parse(handle.meta()) as Meta) : null),
    [handle],
  );
  const rootEvs = useMemo<RootEvs | null>(
    () => (handle ? (JSON.parse(handle.root_evs()) as RootEvs) : null),
    [handle],
  );

  const view = useMemo<View | null>(() => {
    if (!handle) return null;
    const node = JSON.parse(handle.node(nodeId)) as NodeInfo;
    if (node.kind !== "decision" || !node.actions) return { kind: "other", node };

    const player = node.player ?? 0;
    const combos = JSON.parse(handle.combos(nodeId, player)) as Combo[];
    const strategy = handle.strategy(nodeId);
    const numActions = handle.num_actions(nodeId);
    const evs = handle.combo_evs(nodeId, player);
    // Reach x compatible opponent mass: what averages EVs into a cell correctly, at this
    // node and at every action child of it (see buildEvGrid's doc comment).
    const evWeights = handle.combo_ev_weights(nodeId, player);
    const oppCombos = JSON.parse(handle.combos(nodeId, 1 - player)) as Combo[];
    // Action-child EVs: an action doesn't deal a card, so each child shares its parent's
    // live-combo list and slot order exactly (see buildEvGrid's doc comment).
    const actionEvs = node.actions.map((a) => handle.combo_evs(a.child, player));
    const cells = buildGrid(combos, strategy, numActions);

    // Blocker panel needs the opponent's own strategy, which only exists at a node
    // where they are the one deciding. From this hero node, that's whichever action
    // lands directly on a decision node for the opponent -- a hero node can have
    // several actions landing on different opponent response nodes (e.g. check vs.
    // bet), so we take the first one reached; enough to see blocker shifts without
    // asking the user to pick a line. Action edges don't deal a card, so oppCombos
    // above (already fetched at THIS node) has the exact same live-combo list and slot
    // order as that child -- the opponent's own reach isn't touched by hero's choice of
    // action, only the strategy they act with.
    let oppActionNode: NodeInfo | null = null;
    for (const a of node.actions) {
      const child = JSON.parse(handle.node(a.child)) as NodeInfo;
      if (child.kind === "decision" && child.player === 1 - player) {
        oppActionNode = child;
        break;
      }
    }
    const oppActionStrategy = oppActionNode ? handle.strategy(oppActionNode.id) : null;

    return {
      kind: "decision",
      node,
      actions: node.actions,
      player,
      combos,
      strategy,
      evs,
      numActions,
      colors: actionColors(node.actions),
      cells,
      evCells: buildEvGrid(cells, evWeights, strategy, actionEvs, numActions),
      actionEvs,
      // Opponent grid is reach density only — they are not the one choosing here.
      oppCells: buildGrid(oppCombos, new Float32Array(0), 0),
      oppCombos,
      freqs: rangeFreqs(combos, strategy, numActions),
      oppActionNode,
      oppActionStrategy,
      oppActionColors: actionColors(oppActionNode?.actions ?? []),
    };
  }, [handle, nodeId]);

  // One entry per selectable runout card: its own live-combo list, `combo_evs`, and
  // `combo_ev_weights` for the hero, all read at that specific child (see
  // `buildRunoutHotness`'s doc comment for why the parent's combo list can't be reused).
  // Split from `runoutHotness` below so picking a different grid cell -- which only
  // changes the pure aggregation, not which wasm calls are needed -- doesn't re-fetch.
  const runoutChildren = useMemo(() => {
    if (!handle || !view || view.node.kind !== "chance" || !view.node.valid_cards?.length) {
      return null;
    }
    const heroPlayer = findHeroPlayer(handle, view.node.valid_cards[0].child);
    return view.node.valid_cards.map(({ child }) => ({
      id: child,
      combos: JSON.parse(handle.combos(child, heroPlayer)) as Combo[],
      evWeights: handle.combo_ev_weights(child, heroPlayer),
      evs: handle.combo_evs(child, heroPlayer),
    }));
  }, [handle, view]);

  const runoutHotness = useMemo<RunoutHotness | null>(
    () => (runoutChildren ? buildRunoutHotness(runoutChildren, selected) : null),
    [runoutChildren, selected],
  );

  // Keep the URL a live deep link to the current view. replaceState, not pushState --
  // stepping through the tree shouldn't fill the browser's back-button history.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (handle) {
      params.set("node", String(nodeId));
      params.set("mode", gridMode);
      if (selected) params.set("combo", `${selected.row},${selected.col}`);
    }
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [tab, nodeId, selected, gridMode, handle]);

  const step = (s: PathStep) => {
    setPath((p) => [...p, s]);
    setNodeId(s.to);
    // A decision-node action doesn't change which hand class the user was looking at --
    // keep it, so it's still selected if the action lands on a chance node (that's what
    // the runout hotness needs to recolor a single hand's EV per runout). Dealing an
    // actual runout card (kind "chance") is a fresh vantage point: reset, same as before.
    if (s.kind === "chance") setSelected(null);
  };
  const jump = (depth: number) => {
    setPath((p) => p.slice(0, depth));
    setNodeId(depth === 0 ? 0 : path[depth - 1].to);
    setSelected(null);
  };

  // Left/right arrow steps between sibling runouts -- same tree depth, same parent
  // chance node, just a different dealt card -- without walking back up to the card
  // grid. Only live while the current node IS one runout's child (the last path step
  // was a "chance" step); a no-op everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // Other tabs stay mounted but hidden; don't steal their arrow keys or
      // mutate the inspector's position while it isn't the visible view.
      if (tab !== "inspect") return;
      if (!handle || path.length === 0) return;
      const last = path[path.length - 1];
      if (last.kind !== "chance") return;
      const parent = JSON.parse(handle.node(last.from)) as NodeInfo;
      if (!parent.valid_cards) return;
      // Step in the runout grid's own visual order (suit rows s/h/d/c, ranks A→2),
      // not the engine's index order — ArrowRight should move right along the row.
      const gridPos = (card: string) =>
        "shdc".indexOf(card[1]) * 13 + "AKQJT98765432".indexOf(card[0]);
      const ordered = [...parent.valid_cards].sort((a, b) => gridPos(a.card) - gridPos(b.card));
      const idx = ordered.findIndex((v) => v.child === last.to);
      if (idx < 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = ordered[(idx + dir + ordered.length) % ordered.length];
      setPath((p) => [
        ...p.slice(0, -1),
        { ...last, to: next.child, label: last.label.replace(/\S+$/, next.card), token: next.card },
      ]);
      setNodeId(next.child);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handle, path, tab]);

  // A lock names its node by the line walked from the root, so it can only be taken when
  // the breadcrumb actually leads to the node on screen. It doesn't after a deep link
  // (?node=42) or a jump in from the trainer, both of which land on a node with no path.
  const line = lineOf(path);
  const pathLeadsHere = (path.length ? path[path.length - 1].to : 0) === nodeId;
  const lockedHere = locks.some((l) => l.line === line) && pathLeadsHere;

  /** Freeze this node at the strategy on screen; the next solve works around it. */
  const lockCurrentNode = () => {
    if (view?.kind !== "decision" || !pathLeadsHere || !meta) return;
    setLocks((ls) => [
      ...ls.filter((l) => l.line !== line),
      {
        line,
        // The spot this strategy was read from. A later solve of a *different* spot
        // resolves the same line just fine, so the lock has to refuse it itself.
        spot: spotKey(meta),
        player: view.player,
        strategy: Array.from(view.strategy),
        label: path.length ? path.map((s) => s.label).join(" › ") : "root",
      },
    ]);
  };

  const selectedCell: Cell | null =
    view?.kind === "decision" && selected
      ? (view.cells.find((c) => c.row === selected.row && c.col === selected.col) ?? null)
      : null;

  const loaded = !!(handle && view && meta && rootEvs);

  return (
    <div className="app">
      {/* ── RAIL ─────────────────────────────────────────────────────────── */}
      <aside className="rail">
        <a
          href="https://postflop.vercel.app"
          className="block border-b-2 border-[#2a2a26] px-3 py-3.5 max-[999px]:flex max-[999px]:items-center max-[999px]:border-b-0 max-[999px]:py-0"
        >
          <div
            className="text-text-inv"
            style={{ font: "900 20px/1 var(--font-sans)", letterSpacing: "-.03em" }}
          >
            <span className="text-card-s-inv">♠</span>
            <span className="max-[1399px]:hidden min-[1000px]:max-[1399px]:hidden"> POSTFLOP</span>
            <span className="hidden min-[460px]:max-[999px]:inline"> POSTFLOP</span>
          </div>
          <div className="mt-1.5 h-[3px] w-full bg-accent max-[1399px]:hidden min-[1000px]:max-[1399px]:hidden" />
          <div className="label mt-1 text-[9px] max-[1399px]:hidden">HU NLHE WORKBENCH</div>
        </a>

        <nav className="flex flex-col max-[999px]:flex-1 max-[999px]:flex-row">
          {(
            [
              ["inspect", "Inspector", "▦"],
              ["train", "Train", "◎"],
              ["solve", "Solve", "⚙"],
              ["help", "About", "?"],
            ] as [Tab, string, string][]
          ).map(([id, label, glyph]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              aria-label={label}
              className={`h-11 border-b-2 border-[#2a2a26] px-3 text-left uppercase max-[999px]:flex-1 max-[999px]:border-b-0 max-[999px]:text-center ${
                tab === id
                  ? "bg-accent text-[#101010] shadow-[inset_6px_0_0_var(--color-live)]"
                  : "bg-[#101010] text-dim-inv hover:bg-[#2a2a26] hover:text-text-inv"
              }`}
              style={{ font: "800 12px/2.8 var(--font-sans)", letterSpacing: ".06em" }}
            >
              <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">{label}</span>
              <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">
                {glyph}
              </span>
            </button>
          ))}
        </nav>

        <div className="border-b-2 border-[#2a2a26] max-[999px]:hidden min-[1000px]:max-[1399px]:hidden">
          {loaded && meta ? (
            <>
              <div className="bar">LOADED</div>
              <div className="px-3 py-2.5 min-[1000px]:max-[1399px]:hidden">
                <div className="num break-all text-[11px] text-text-inv">{source}</div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="label">NODES</span>
                  <span className="num text-text-inv">{meta.node_count.toLocaleString()}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="label">ENGINE</span>
                  <span className="num text-text-inv">{meta.engine_version}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="label">ITERS</span>
                  <span className="num text-text-inv">{meta.iterations.toLocaleString()}</span>
                </div>
              </div>
              <div className="px-3 pb-3 min-[1400px]:pt-0 max-[1399px]:px-1 max-[1399px]:pt-2">
                <div className="label mb-1 min-[1000px]:max-[1399px]:hidden">EXPLOITABILITY</div>
                <div className="w-full bg-accent px-2 py-1.5 text-[#101010]">
                  <span className="fig fig-2">{meta.exploitability_pct_of_pot.toFixed(4)}%</span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-0 p-2">
              {SAMPLES.map((s) => (
                <button
                  key={s.file}
                  data-testid={`sample-${s.file}`}
                  onClick={() => loadSample(s.file, s.name)}
                  title={s.detail}
                  className="btn-inv mb-2 h-[34px] w-full border-2"
                  style={{ font: "800 11px/1 var(--font-sans)", letterSpacing: ".06em", textTransform: "uppercase" }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-auto max-[999px]:mt-0 max-[999px]:hidden">
          <button
            onClick={() => fileInput.current?.click()}
            aria-label="Open a solution file"
            className="btn-inv block h-[34px] w-full border-0 border-t-2 border-[#2a2a26] uppercase"
            style={{ font: "800 11px/1 var(--font-sans)", letterSpacing: ".06em" }}
            title="Open a solution file written by the solver CLI or exported from this page"
          >
            <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">Open file…</span>
            <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">⤓</span>
          </button>
          <button
            data-testid="export"
            disabled={!handle}
            onClick={exportJson}
            aria-label="Export solution as JSON"
            title="Export the loaded solution as a JSON file"
            className="btn-inv block h-[34px] w-full border-0 border-t-2 border-[#2a2a26] uppercase"
            style={{ font: "800 11px/1 var(--font-sans)", letterSpacing: ".06em" }}
          >
            <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">Export JSON</span>
            <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">⤒</span>
          </button>
          {locks.length > 0 && (
            <button
              data-testid="lock-count"
              onClick={() => setTab("solve")}
              aria-label={`${locks.length} node locks pending, review on the Solve tab`}
              title="Review the pending locks on the Solve tab and re-solve"
              className="btn-inv block h-[34px] w-full border-0 border-t-2 border-[#2a2a26] uppercase"
              style={{ font: "800 11px/1 var(--font-sans)", letterSpacing: ".06em" }}
            >
              <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">{locks.length} locks pending →</span>
              <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">{locks.length}</span>
            </button>
          )}
          <div className="seg on-ink border-t-2 border-[#2a2a26]" role="group" aria-label="theme">
            <button
              aria-pressed={theme === "light"}
              onClick={() => setThemeAndPersist("light")}
              className="h-[30px] flex-1 border-0"
            >
              ☀<span className="min-[1000px]:max-[1399px]:hidden"> BONE</span>
            </button>
            <button
              aria-pressed={theme === "dark"}
              onClick={() => setThemeAndPersist("dark")}
              className="h-[30px] flex-1 border-0"
            >
              ☾<span className="min-[1000px]:max-[1399px]:hidden"> INK</span>
            </button>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </aside>

      {/* ── STAGE ────────────────────────────────────────────────────────── */}
      <div className="stage">
        {error && (
          <div data-testid="banner" role="alert" className="flex items-center gap-3 border-b-[3px] border-err bg-err-bg px-3.5 py-2">
            <span
              className="bg-ink px-2 py-1 uppercase text-text-inv"
              style={{ font: "800 10px/1 var(--font-sans)", letterSpacing: ".12em" }}
            >
              Could not load
            </span>
            <span className="num text-[12px]">{error}</span>
          </div>
        )}
        {!error && loading && (
          <div
            data-testid="banner"
            className="relative bg-accent px-3.5 py-1.5 uppercase text-[#101010]"
            style={{ font: "800 12px/1.4 var(--font-sans)", letterSpacing: ".08em" }}
          >
            reading…
            <span className="slide-rule" style={{ background: "var(--color-ink)" }} />
          </div>
        )}

        {tab === "inspect" && loaded && view && meta && rootEvs && (
          <StatBand meta={meta} rootEvs={rootEvs} source={source} node={view.node} />
        )}

        {tab === "inspect" && loaded && view && (
          <TreeNav
            node={view.node}
            path={path}
            freqs={view.kind === "decision" ? view.freqs : []}
            colors={view.kind === "decision" ? view.colors : []}
            onStep={step}
            onJump={jump}
          />
        )}

        <div className={tab === "help" ? "help-shell" : "hidden"}>
          <Help />
        </div>
        {/* Kept mounted: unmounting on the tab switch would throw away the progress curve
            of the solve that just finished, which is exactly when it is worth reading. */}
        <div className={tab === "solve" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <SolvePanel
            locks={locks}
            onRemoveLock={(l) => setLocks((ls) => ls.filter((x) => x.line !== l))}
            onClearLocks={() => setLocks([])}
            onSolved={(json, wall, ctx) => {
              setSpotContext(ctx);
              return adopt(json, `browser solve (${wall.toFixed(2)}s)`);
            }}
          />
        </div>
        {/* Kept mounted for the same reason as the solve panel: switching to the inspector
            to review a hand must not throw away the session's score and played-hands list. */}
        <div className={tab === "train" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <TrainPanel
            handle={handle}
            spotContext={spotContext}
            samples={SAMPLES}
            onLoadSample={(file, name) => void loadSample(file, name, true)}
            onSolved={(json, wall, ctx) => {
              setSpotContext(ctx);
              return adopt(json, `browser solve (${wall.toFixed(2)}s)`, true);
            }}
            onReview={(node, cell) => {
              setNodeId(node);
              setPath([]);
              setSelected(cell);
              setTab("inspect");
            }}
          />
        </div>

        {tab === "inspect" &&
          (!loaded || !view ? (
            booted ? (
              <Empty
                error={error}
                onSample={loadSample}
                onSolveTab={() => setTab("solve")}
                onOpen={() => fileInput.current?.click()}
                onFile={onFile}
              />
            ) : (
              <Booting />
            )
          ) : view.kind === "decision" ? (
            <div className="inspector rule-t">
              {/* Column 1 — strategy grid */}
              <section className="flex flex-col bg-panel">
                <div className="bar bar-strategy">
                  {PLAYER_NAMES[view.player]} strategy
                  <span className="meta">
                    {view.combos.length} combos · node {view.node.id} · {view.node.street}
                  </span>
                  <span className="right">
                    <button
                      data-testid="lock-node"
                      disabled={!pathLeadsHere}
                      onClick={lockCurrentNode}
                      title={
                        pathLeadsHere
                          ? "Freeze this node at the strategy shown and solve the rest of the tree around it, on the next solve."
                          : "Walk down from root to lock a node: a deep link lands here without a line."
                      }
                      className={`border-2 px-2 py-1 text-[10px] uppercase disabled:opacity-40 ${
                        lockedHere
                          ? "border-ink bg-accent text-[#101010]"
                          : "border-dim-inv bg-[#2a2a26] text-text-inv hover:bg-accent hover:text-[#101010]"
                      }`}
                      style={{ font: "800 10px/1 var(--font-sans)", letterSpacing: ".06em" }}
                    >
                      {lockedHere ? "lock updated" : "lock node"}
                    </button>
                    {!wide && (
                      <span className="seg">
                        {(["strategy", "ev", "regret"] as const).map((m) => (
                          <button key={m} aria-pressed={gridMode === m} onClick={() => setGridMode(m)}>
                            {m}
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
                <div className="p-2.5">
                  <RangeGrid
                    cells={view.cells}
                    colors={view.colors}
                    mode={wide ? "strategy" : gridMode}
                    evCells={view.evCells}
                    actions={view.actions}
                    size="large"
                    selected={selected}
                    onSelect={(c) => setSelected({ row: c.row, col: c.col })}
                  />
                </div>
                <Legend
                  actions={view.actions}
                  colors={view.colors}
                  freqs={view.freqs}
                  mode={wide ? "strategy" : gridMode}
                />
              </section>

              {/* Column 2 — EV/regret twin grid, ≥1900px only */}
              <section className="col-ev flex-col bg-panel">
                <div className="bar bar-ev">
                  {gridMode === "regret" ? "Regret surface" : "EV surface"}
                  <span className="meta">same node · same selection</span>
                  <span className="right">
                    <span className="seg">
                      {(["ev", "regret"] as const).map((m) => (
                        <button key={m} aria-pressed={(gridMode === "regret" ? "regret" : "ev") === m} onClick={() => setGridMode(m)}>
                          {m}
                        </button>
                      ))}
                    </span>
                  </span>
                </div>
                <div className="p-2.5">
                  <RangeGrid
                    cells={view.cells}
                    colors={view.colors}
                    mode={gridMode === "regret" ? "regret" : "ev"}
                    evCells={view.evCells}
                    actions={view.actions}
                    size="large"
                    selected={selected}
                    onSelect={(c) => setSelected({ row: c.row, col: c.col })}
                  />
                </div>
                <div
                  className="mt-auto border-t-2 border-ink bg-paper-2 px-2.5 py-2 text-[11px] text-muted"
                >
                  {LEGEND_CAPTION[gridMode === "regret" ? "regret" : "ev"]}
                </div>
              </section>

              {/* Column 3 — combo breakdown */}
              <section className="flex flex-col bg-panel">
                <ComboPanel
                  cell={selectedCell}
                  combos={view.combos}
                  strategy={view.strategy}
                  evs={view.evs}
                  actionEvs={view.actionEvs}
                  actions={view.actions}
                  colors={view.colors}
                  freqs={view.freqs}
                  player={PLAYER_NAMES[view.player]}
                  onPickCell={(c) => setSelected(c)}
                />
              </section>

              {/* Side column — opponent range + blockers */}
              <div className="col-side flex flex-col">
                <section className="flex flex-col bg-panel">
                  <div className="bar bar-opp">
                    {PLAYER_NAMES[1 - view.player]} range
                    <span className="meta">{view.oppCombos.length} combos · reach-weighted</span>
                  </div>
                  <div className="p-2">
                    {/* Width cap: in the 1100–1499px full-width side row this grid would
                        otherwise stretch to half the stage and dwarf the strategy grid. */}
                    <div style={{ maxWidth: 360 }}>
                      <RangeGrid cells={view.oppCells} colors={["#48566f"]} mode="reach" size="small" />
                    </div>
                  </div>
                  <p className="border-t-2 border-ink bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
                    Density is that hand&apos;s reach at this node: range weight times their own
                    strategy along the line. They are not acting here, so there are no action
                    frequencies to show.
                  </p>
                </section>
                <section className="flex min-h-0 flex-1 flex-col rule-t bg-panel">
                  <BlockerPanel
                    cell={selectedCell}
                    combos={view.combos}
                    oppCombos={view.oppCombos}
                    oppStrategy={view.oppActionStrategy}
                    oppActions={view.oppActionNode?.actions ?? []}
                    oppColors={view.oppActionColors}
                    oppPlayer={PLAYER_NAMES[1 - view.player]}
                  />
                </section>
              </div>
            </div>
          ) : view.node.kind === "chance" ? (
            <ChanceView node={view.node} hotness={runoutHotness} onStep={step} />
          ) : (
            <TerminalView node={view.node} path={path} onJump={jump} />
          ))}
      </div>

      {/* ── STATUS BAR ───────────────────────────────────────────────────── */}
      <footer className="statusbar on-ink flex items-center overflow-x-auto whitespace-nowrap px-2.5">
        <StatusSeg label={loaded ? `NODE ${nodeId}` : "NO SPOT"} value={loaded && view ? view.node.kind.toUpperCase() : booted ? "WASM IDLE" : "BOOTING"} />
        <StatusSeg label="COMBOS" value={view?.kind === "decision" ? view.combos.length.toLocaleString() : "0"} />
        <StatusSeg label="ITERS" value={meta ? meta.iterations.toLocaleString() : "0"} />
        <StatusSeg label="EXPL" value={meta ? `${meta.exploitability_pct_of_pot.toFixed(4)}%` : "—"} />
        <StatusSeg label="NODES" value={meta ? meta.node_count.toLocaleString() : "0"} />
        <StatusSeg label="MODE" value={gridMode.toUpperCase()} />
        <StatusSeg
          label="SEL"
          value={
            selectedCell
              ? `${selectedCell.label} (${selectedCell.slots.length} combo${selectedCell.slots.length === 1 ? "" : "s"})`
              : "NO SELECTION"
          }
        />
        <StatusSeg label="LOCKS" value={String(locks.length)} />
        <span
          className="num ml-auto overflow-hidden text-ellipsis pl-2.5 text-[11px] text-dim-inv"
          title={path.length ? "root › " + path.map((s) => s.label).join(" › ") : "root"}
        >
          LINE <span className="text-text-inv">{path.length ? "root › " + path.map((s) => s.label).join(" › ") : "root"}</span>
        </span>
      </footer>
    </div>
  );
}

function StatusSeg({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="num text-[11px] text-dim-inv">
        {label} <span className="text-text-inv">{value}</span>
      </span>
      <span className="px-2.5 text-[#2a2a26]">│</span>
    </>
  );
}

function Booting() {
  return (
    <div className="on-ink relative flex flex-1 items-center">
      <span
        className="px-6 uppercase text-dim-inv"
        style={{ font: "800 12px/1.2 var(--font-sans)", letterSpacing: ".12em" }}
      >
        Reading fixture-turn.json
      </span>
      <span className="slide-rule" />
    </div>
  );
}

/** Stat band: the stage's one yellow block lives here (exploitability). */
function StatBand({
  meta,
  rootEvs,
  source,
  node,
}: {
  meta: Meta;
  rootEvs: RootEvs;
  source: string;
  node: NodeInfo;
}) {
  return (
    <section className="on-ink rule-b flex flex-wrap">
      <StatTile label="BOARD" first wide>
        <BoardStrip board={node.board} size={20} variant="stock" />
      </StatTile>
      <StatTile label="POT · BB">
        <span className="fig fig-2">{node.pot.toFixed(2)}</span>
      </StatTile>
      <StatTile label="STACKS · BB">
        <span className="num text-[15px] text-text-inv">
          {node.stacks[0].toFixed(2)} / {node.stacks[1].toFixed(2)}
        </span>
      </StatTile>
      <StatTile label="EXPLOITABILITY">
        <span className="inline-block bg-accent px-2 py-1 text-[#101010]">
          <span className="fig fig-1">{meta.exploitability_pct_of_pot.toFixed(4)}%</span>
        </span>
        <span className="num mt-1 block text-[11px] text-dim-inv">
          {meta.exploitability_chips.toFixed(6)} bb
        </span>
      </StatTile>
      <StatTile label="ROOT EV · ZERO-SUM · BB">
        <span className="fig fig-2">{rootEvs.zero_sum[0].toFixed(4)}</span>
        <span className="num text-dim-inv"> / {rootEvs.zero_sum[1].toFixed(4)}</span>
      </StatTile>
      <StatTile label="ROOT EV · POT-SHARE">
        <span className="fig fig-2">{rootEvs.pot_share[0].toFixed(4)}</span>
        <span className="num text-dim-inv"> / {rootEvs.pot_share[1].toFixed(4)}</span>
      </StatTile>
      <StatTile label="SOLVE">
        <div className="num text-[12px] leading-snug text-text-inv">
          {meta.iterations.toLocaleString()} iters
          <br />
          {meta.wall_seconds.toFixed(3)} s · engine {meta.engine_version}
          <br />
          {meta.node_count.toLocaleString()} nodes{source ? ` · ${source}` : ""}
        </div>
      </StatTile>
    </section>
  );
}

function StatTile({
  label,
  first = false,
  wide = false,
  children,
}: {
  label: string;
  first?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${wide ? "min-w-[230px]" : "min-w-[150px]"} flex-1 overflow-hidden px-3.5 py-2.5`}
      style={first ? undefined : { borderLeft: "var(--rule) solid var(--color-ink)" }}
    >
      <div className="label mb-1">{label}</div>
      {children}
    </div>
  );
}

/** Chance node: the runout matrix at full size beside a per-runout EV table. */
function ChanceView({
  node,
  hotness,
  onStep,
}: {
  node: NodeInfo;
  hotness: RunoutHotness | null;
  onStep: (s: PathStep) => void;
}) {
  const valid = node.valid_cards ?? [];
  const nextStreet = node.board.length === 3 ? "turn" : "river";
  const rows = valid
    .map((v) => ({
      card: v.card,
      child: v.child,
      ev: hotness?.evByChild.get(v.child) ?? NaN,
      dev: hotness?.deviationByChild.get(v.child) ?? NaN,
    }))
    .sort((a, b) => (Number.isNaN(b.dev) ? -Infinity : b.dev) - (Number.isNaN(a.dev) ? -Infinity : a.dev));
  const maxDev = hotness?.maxDeviation ?? 0;

  return (
    <div className="rule-t grid min-h-0 flex-1 grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_420px]">
      <section className="flex min-h-0 flex-col overflow-y-auto bg-panel">
        <h2 className="bar">
          Deal the {nextStreet}
          <span className="meta">
            {valid.length} of 52 available · {node.board.length} on board
          </span>
        </h2>
        <div className="flex flex-1 items-center justify-center p-6">
          <RunoutSelector node={node} onStep={onStep} hotness={hotness} size="large" />
        </div>
      </section>
      <section className="flex min-h-0 flex-col overflow-y-auto rule-l bg-panel max-[1099px]:rule-t">
        <h2 className="bar bar-ev">
          Runout EV
          <span className="meta">
            {rows.length} runouts · max |Δ| {maxDev.toFixed(3)} bb
          </span>
        </h2>
        <div className="grid grid-cols-[64px_1fr_1fr] border-b-2 border-ink bg-paper-2 px-2.5 py-1.5">
          <span className="label">card</span>
          <span className="label text-right">hero EV</span>
          <span className="label text-right">vs. mean</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((r, i) => (
            <button
              key={r.card}
              onClick={() =>
                onStep({ from: node.id, to: r.child, kind: "chance", label: `${nextStreet} ${r.card}`, token: r.card })
              }
              className={`grid h-[26px] w-full grid-cols-[64px_1fr_1fr] items-center px-2.5 text-left hover:bg-accent ${
                i % 2 === 1 ? "bg-paper-2" : ""
              }`}
            >
              <Card card={r.card} className="text-[13px]" />
              <span className="num text-right">{Number.isNaN(r.ev) ? "—" : r.ev.toFixed(3)}</span>
              <span
                className={`num text-right ${Number.isNaN(r.dev) ? "text-dim" : r.dev >= 0 ? "text-ok" : "text-err"}`}
              >
                {Number.isNaN(r.dev) ? "—" : `${r.dev >= 0 ? "+" : ""}${r.dev.toFixed(3)}`}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Terminal node: the hand is over — a poster, not a hint sentence. */
function TerminalView({
  node,
  path,
  onJump,
}: {
  node: NodeInfo;
  path: PathStep[];
  onJump: (depth: number) => void;
}) {
  const t = node.terminal;
  return (
    <div className="rule-t flex-1 bg-panel" style={{ padding: "clamp(24px,3vw,48px)" }}>
      <h2 className="bar mb-6">Terminal</h2>
      <div
        className="uppercase"
        style={{ font: "900 clamp(32px,4vw,64px)/1 var(--font-sans)", letterSpacing: "-.04em" }}
      >
        {t?.kind === "fold" ? `${PLAYER_NAMES[t.folder]} folds` : "Showdown"}
      </div>
      <div className="label mt-6">POT · BB</div>
      <div className="fig fig-1">{t?.pot.toFixed(2)}</div>
      <p className="num mt-6 text-muted">
        no strategy here. step back up the line to keep inspecting
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button className="chip" onClick={() => onJump(0)}>
          root
        </button>
        {path.map((s, i) => (
          <button key={i} className="chip" onClick={() => onJump(i + 1)}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const LEGEND_CAPTION: Record<"strategy" | "ev" | "regret", string> = {
  strategy: "cells weighted by live combo reach · faded = zero reach · dark = no live combos",
  ev: "color = highest-EV action · ivory = near-indifferent · dark = no EV data",
  regret: "color = bb lost vs. the best action · ivory = no regret · dark = no EV data",
};

function Legend({
  actions,
  colors,
  freqs,
  mode,
}: {
  actions: NodeAction[];
  colors: string[];
  freqs: number[];
  mode: "strategy" | "ev" | "regret";
}) {
  return (
    <div className="mt-auto flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t-2 border-ink bg-paper-2 px-2.5 py-2">
      {actions.map((a, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span className="h-1 w-4" style={{ background: colors[i] }} />
          <span className="num text-[12px]">{a.text}</span>
          <span style={{ font: "800 12px/1 var(--font-sans)" }}>
            {((freqs[i] ?? 0) * 100).toFixed(1)}%
          </span>
        </span>
      ))}
      <span className="label ml-auto">{LEGEND_CAPTION[mode]}</span>
    </div>
  );
}

/**
 * The no-solution screen. Renders only when the boot fixture failed or a user file
 * failed to parse — three full-bleed rows: poster headline, four entry slabs, and a
 * spec sheet that teaches the colour language. Zero exposed void.
 */
function Empty({
  error,
  onSample,
  onSolveTab,
  onOpen,
  onFile,
}: {
  error: string | null;
  onSample: (file: string, name: string) => void;
  onSolveTab: () => void;
  onOpen: () => void;
  onFile: (f: File | undefined) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="rule-t grid min-h-0 flex-1 grid-rows-[auto_minmax(280px,38%)_minmax(0,1fr)] overflow-y-auto">
      {/* Row 1 — poster headline */}
      <div className="rule-b bg-panel" style={{ padding: "clamp(24px,3vw,56px)" }}>
        <h1
          className="uppercase"
          style={{ font: "900 clamp(48px,6vw,112px)/0.92 var(--font-sans)", letterSpacing: "-.045em" }}
        >
          No solution{" "}
          <span className="bg-accent text-[#101010]" style={{ padding: "0 .12em" }}>
            loaded
          </span>
        </h1>
        <p className="num mt-4 max-w-[74ch] text-[14px] text-muted">
          load a solution file, pick a bundled sample, or solve a spot in the browser. loading
          rebuilds the tree and reads stored strategies, it never re-solves.
        </p>
        {error && (
          <p className="num mt-3 text-[13px] text-err">
            <span
              className="mr-2 bg-ink px-2 py-0.5 uppercase text-text-inv"
              style={{ font: "800 10px/1.4 var(--font-sans)", letterSpacing: ".1em" }}
            >
              could not load
            </span>
            {error}
          </p>
        )}
      </div>

      {/* Row 2 — four entry slabs */}
      <div className="rule-b flex min-h-[280px] flex-wrap">
        {SAMPLES.map((s, i) => (
          <div
            key={s.file}
            className={`on-ink flex min-w-[280px] flex-1 basis-1/2 flex-col min-[1500px]:basis-0 ${
              i > 0 ? "rule-l" : ""
            }`}
          >
            <div className="flex flex-1 flex-col gap-3 p-5">
              <Cards cards={s.board} variant="stock" size={22} className="gap-1.5" />
              <div
                className="uppercase text-text-inv"
                style={{ font: "900 clamp(24px,2vw,36px)/1 var(--font-sans)", letterSpacing: "-.03em" }}
              >
                {s.name}
              </div>
              <div className="num text-[12px] text-dim-inv">{s.detail}</div>
            </div>
            <button
              data-testid={`empty-sample-${s.file}`}
              onClick={() => onSample(s.file, s.name)}
              className="h-11 w-full bg-[#2a2a26] uppercase text-text-inv hover:bg-accent hover:text-[#101010]"
              style={{ font: "800 13px/1 var(--font-sans)", letterSpacing: ".08em" }}
            >
              Load →
            </button>
          </div>
        ))}
        <button
          onClick={onOpen}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void onFile(e.dataTransfer.files?.[0]);
          }}
          className={`rule-l flex min-w-[280px] flex-1 basis-1/2 flex-col items-start justify-center gap-3 p-5 text-left min-[1500px]:basis-0 max-[1499px]:rule-t ${
            dragging ? "bg-accent" : "bg-panel"
          }`}
          style={{ outline: "3px dashed var(--color-ink)", outlineOffset: "-12px" }}
        >
          <span
            className="uppercase"
            style={{ font: "900 clamp(22px,1.8vw,30px)/1 var(--font-sans)", letterSpacing: "-.03em" }}
          >
            Open file…
          </span>
          <span className="num text-[12px] text-muted">
            a solution written by the CLI, or exported from this page. drop it anywhere on this
            block
          </span>
        </button>
        <button
          onClick={onSolveTab}
          className="rule-l flex min-w-[280px] flex-1 basis-1/2 flex-col items-start justify-center gap-3 bg-accent p-5 text-left text-[#101010] min-[1500px]:basis-0 max-[1499px]:rule-t"
        >
          <span
            className="uppercase"
            style={{ font: "900 clamp(22px,1.8vw,30px)/1 var(--font-sans)", letterSpacing: "-.03em" }}
          >
            Solve a new spot →
          </span>
          <span className="num text-[12px]">
            set a board, two ranges and a sizing tree; the engine runs as WebAssembly on this page
          </span>
        </button>
      </div>

      {/* Row 3 — spec sheet */}
      <div className="grid min-h-0 grid-cols-1 min-[1000px]:grid-cols-[380px_minmax(0,1fr)] min-[1280px]:grid-cols-[380px_repeat(3,minmax(0,1fr))]">
        <div className="bg-panel p-4">
          <div style={{ display: "grid", gridTemplateColumns: "var(--axis) repeat(13, minmax(0,1fr))", gap: 2, padding: 2, background: "var(--color-ink)" }}>
            <span />
            {"AKQJT98765432".split("").map((r) => (
              <span key={`c${r}`} className="flex items-center justify-center" style={{ font: "700 8px/1 var(--font-mono)", color: "var(--color-dim-inv)", minHeight: "var(--axis)" }}>
                {r}
              </span>
            ))}
            {Array.from({ length: 169 }, (_, i) => {
              const row = Math.floor(i / 13);
              const col = i % 13;
              const fill = row === col ? "#48566f" : row < col ? "#2b7c50" : "#2a2a26";
              return (
                <Fragment169 key={i} first={col === 0} rank={"AKQJT98765432"[row]}>
                  <span
                    className="flex aspect-square items-center justify-center"
                    style={{ background: fill, font: "700 8px/1 var(--font-mono)", color: "rgba(244,241,232,.85)" }}
                  >
                    {cellLabel(row, col)}
                  </span>
                </Fragment169>
              );
            })}
          </div>
          <div className="label mt-2">169 hand classes · 1,326 combinations</div>
          <p className="num mt-1 text-[11px] text-muted">
            six combinations per pair on the diagonal, four per suited hand above it, twelve per
            offsuit hand below. every cell opens a combo breakdown.
          </p>
        </div>
        <SpecCol title="Action colors">
          {[
            ["#e2705c", "bet, smallest sizing"],
            ["#d1462f", "bet"],
            ["#b02a16", "bet"],
            ["#8f1a0d", "bet"],
            ["#6e1209", "bet, largest sizing"],
            ["#54ad72", "check"],
            ["#2b7c50", "call"],
            ["#48566f", "fold"],
          ].map(([hex, label]) => (
            <div key={hex + label} className="flex items-center gap-2.5 py-1">
              <span className="h-[5px] w-5" style={{ background: hex }} />
              <span className="num text-[12px]">{label}</span>
            </div>
          ))}
          <p className="num mt-2 text-[11px] text-muted">
            colors are consistent in every grid, table and tree block on this page.
          </p>
        </SpecCol>
        <SpecCol title="Grid modes">
          {(
            [
              ["strategy", ["#b02a16", "#54ad72", "#48566f"]],
              ["ev", ["#b02a16", "#d8b8ae", "#f4f1e8"]],
              ["regret", ["#f4f1e8", "#f6d199", "#e0883d"]],
            ] as [string, string[]][]
          ).map(([m, sw]) => (
            <div key={m} className="flex items-start gap-2.5 py-1.5">
              <span className="grid shrink-0 grid-cols-3" style={{ width: 30 }}>
                {[...sw, ...sw, ...sw].map((c, i) => (
                  <span key={i} className="aspect-square" style={{ background: c }} />
                ))}
              </span>
              <div>
                <div className="label">{m}</div>
                <div className="num text-[11px] text-muted">
                  {LEGEND_CAPTION[m as keyof typeof LEGEND_CAPTION]}
                </div>
              </div>
            </div>
          ))}
        </SpecCol>
        <SpecCol title="Keys & gestures">
          {[
            "← → step sibling runouts",
            "click a cell to drill in combo by combo",
            "lock a node and solve the rest around it",
            "deep links carry ?node and ?combo",
            "every figure on screen came out of the engine",
          ].map((t) => (
            <div key={t} className="num py-1 text-[12px]">
              {t}
            </div>
          ))}
        </SpecCol>
      </div>
    </div>
  );
}

/** Row-header + cell pair for the empty-state lattice. */
function Fragment169({
  first,
  rank,
  children,
}: {
  first: boolean;
  rank: string;
  children: React.ReactNode;
}) {
  return (
    <>
      {first && (
        <span
          className="flex items-center justify-center"
          style={{ font: "700 8px/1 var(--font-mono)", color: "var(--color-dim-inv)" }}
        >
          {rank}
        </span>
      )}
      {children}
    </>
  );
}

function SpecCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rule-l flex flex-col bg-panel max-[999px]:rule-t max-[999px]:border-l-0">
      <h2 className="bar">{title}</h2>
      <div className="p-4">{children}</div>
    </div>
  );
}
