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
import Tour, { type TourStep } from "@/components/Tour";
import {
  Cell,
  CellEv,
  RunoutHotness,
  actionColors,
  buildEvGrid,
  buildGrid,
  buildRunoutHotness,
  cellLabel,
  hatched,
  rampMix,
  rangeFreqs,
  regretColor,
} from "@/lib/grid";
import { PRESETS, actionToken, lineOf, spotKey, type NodeLock, type SpotContext } from "@/lib/config";
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
  /** The chipEV twin of an ICM solve: the same spot, same iterations, `[tournament]`
   *  stripped. Null for a chip solve, a loaded file or a sample: nothing else in the
   *  app produces a matched pair. */
  const [chipTwin, setChipTwin] = useState<SolutionHandle | null>(null);
  const [source, setSource] = useState<string>("");
  /** Table context of the loaded spot: positions and modeled player profiles. Known for
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
  const liveTwin = useRef<SolutionHandle | null>(null);
  /** Only the first solution load consults the URL; every later load resets to root
   *  the way it always has (loading a different solution mid-session isn't a restore). */
  const restoredFromUrl = useRef(false);
  // Snapshot the URL exactly once, in an effect rather than during render (refs can't be
  // read or written while rendering) and before the sync effect below gets a chance to
  // rewrite it: a bookmarked deep link (?node=42&combo=3,5) has to survive being read by
  // adopt() even though that effect will have already replaced the address bar by then.
  const initialParams = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    // Guarded: a StrictMode remount re-runs this AFTER the sync effect already
    // rewrote the address bar, and re-capturing then would lose ?node/?tour.
    if (!initialParams.current) {
      initialParams.current = new URLSearchParams(window.location.search);
    }
  }, []);

  const adopt = useCallback((json: string, label: string, keepTab = false, chipJson?: string) => {
    setError(null);
    setLoading(true);
    return loadWasm()
      .then((wasm) => {
        // Structure-guard + strategy-width validation happen here, not on a re-solve.
        const next = wasm.load_solution(json);
        // Free the old handle OUTSIDE the state updater. A `setState` updater has to be
        // pure: React replays it (StrictMode double-invoke, render restarts), and a
        // second `free()` on the same pointer traps with "null pointer passed to rust".
        const previous = live.current;
        live.current = next;
        setHandle(next);
        previous?.free();
        setSource(label);

        // Same treatment for the twin: replace the ref first, free the old pointer after
        // the state updater has run. A solve without a twin clears the previous one, so
        // the comparison band can never outlive the pair it was measured on.
        const twin = chipJson ? wasm.load_solution(chipJson) : null;
        const previousTwin = liveTwin.current;
        liveTwin.current = twin;
        setChipTwin(twin);
        previousTwin?.free();

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
  // This file is the page's boot payload, so scripts/sync-wasm.mjs rounds its floats
  // on the way into public/fixtures: it is 88% digits nobody can read.
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
      // Opponent grid is reach density only: they are not the one choosing here.
      oppCells: buildGrid(oppCombos, new Float32Array(0), 0),
      oppCombos,
      freqs: rangeFreqs(combos, strategy, numActions),
      oppActionNode,
      oppActionStrategy,
    };
  }, [handle, nodeId]);

  /**
   * The two strategies at the node on screen, as range-level action frequencies.
   *
   * Stripping `[tournament]` changes payoffs, never the tree, so the twin has the same
   * node ids, acting players and action lists, but that is an argument, not a promise,
   * so the widths are checked before the two are put beside each other and a mismatch
   * renders nothing rather than a wrong delta.
   */
  const icmCompare = useMemo(() => {
    if (!chipTwin || !view || view.kind !== "decision") return null;
    try {
      if (chipTwin.num_actions(view.node.id) !== view.numActions) return null;
      const chipCombos = JSON.parse(chipTwin.combos(view.node.id, view.player)) as Combo[];
      if (chipCombos.length !== view.combos.length) return null;
      const chipFreqs = rangeFreqs(chipCombos, chipTwin.strategy(view.node.id), view.numActions);
      const chipMeta = JSON.parse(chipTwin.meta()) as Meta;
      const chipRootEvs = JSON.parse(chipTwin.root_evs()) as RootEvs;
      return { chipFreqs, chipMeta, chipRootEvs };
    } catch {
      return null;
    }
  }, [chipTwin, view]);

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
      // not the engine's index order: ArrowRight should move right along the row.
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

  // ── Guided tour ──────────────────────────────────────────────────────────
  /** Current tour step index; null while the tour is closed. */
  const [tour, setTour] = useState<number | null>(null);
  const tourOffered = useRef(false);

  // Offer the tour once per browser (localStorage), or on demand via ?tour=1.
  // Never hijack a deep link into a specific node, combo, or non-default tab,
  // and node=0 doesn't count as one, because the URL-sync effect writes it into
  // every visitor's address bar seconds after boot.
  useEffect(() => {
    if (tourOffered.current || !booted) return;
    // Arm on boot even if the fixture failed: a tour that pops open minutes
    // later, when the user loads their own file, would steal the tab.
    tourOffered.current = true;
    if (!handle) return;
    const params = initialParams.current;
    const want = params?.get("tour") === "1";
    let seen = false;
    try {
      seen = localStorage.getItem("pf-tour-done") === "1";
    } catch {}
    const node = params?.get("node");
    const deepLinked = !!(
      (node && node !== "0") ||
      params?.get("combo") ||
      (params?.get("tab") && params.get("tab") !== "inspect")
    );
    // Auto-offer only where the full inspector layout has room; an explicit
    // ?tour=1 request is honored at any width.
    const roomy = window.innerWidth >= 1000;
    if (want || (roomy && !seen && !deepLinked)) setTour(0);
  }, [booted, handle]);

  const goRoot = useCallback(() => {
    setPath([]);
    setNodeId(0);
  }, []);

  /** Walk from the root down non-fold actions to the first chance node (the
   *  runout selector), building the same path `step()` would have. */
  const goToRunouts = useCallback(() => {
    if (!handle) return;
    let node = JSON.parse(handle.node(0)) as NodeInfo;
    const steps: PathStep[] = [];
    let guard = 0;
    while (node.kind === "decision" && node.actions?.length && guard++ < 16) {
      const a = node.actions.find((x) => !/fold/i.test(x.text)) ?? node.actions[0];
      steps.push({
        from: node.id,
        to: a.child,
        kind: "action",
        label: `${PLAYER_NAMES[node.player ?? 0]} ${a.text}`,
        token: actionToken(a),
      });
      node = JSON.parse(handle.node(a.child)) as NodeInfo;
    }
    if (node.kind !== "chance") return; // river spot: no runout to show, card centers itself
    setPath(steps);
    setNodeId(node.id);
    setSelected(null);
  }, [handle]);

  const closeTour = useCallback(
    (finished: boolean) => {
      setTour(null);
      try {
        localStorage.setItem("pf-tour-done", "1");
      } catch {}
      if (finished) {
        setTab("inspect");
        goRoot();
        setSelected(null);
        setGridMode("strategy");
      }
    },
    [goRoot],
  );

  /** Facts about the loaded solution the tour copy must not lie about: the root
   *  board, and whether a chance node is reachable (a river spot has none, so
   *  the runouts step is dropped rather than shown over the wrong screen). */
  const tourFacts = useMemo(() => {
    if (!handle) return null;
    const root = JSON.parse(handle.node(0)) as NodeInfo;
    let n = root;
    let guard = 0;
    while (n.kind === "decision" && n.actions?.length && guard++ < 16) {
      const a = n.actions.find((x) => !/fold/i.test(x.text)) ?? n.actions[0];
      n = JSON.parse(handle.node(a.child)) as NodeInfo;
    }
    return { board: root.board.join(" "), street: root.street, hasChance: n.kind === "chance" };
  }, [handle]);

  /** The cell the combo step opens: the root-node hand class with the most live
   *  combos, so the panel is never empty whatever solution is loaded. */
  const tourCell = useMemo(() => {
    if (view?.kind !== "decision") return { row: 0, col: 1, label: "A hand class" };
    const best = view.cells.reduce((b, c) => (c.slots.length > b.slots.length ? c : b));
    return { row: best.row, col: best.col, label: best.label };
  }, [view]);

  /** What a graded number is denominated in on the loaded solve. The tour bodies below
   *  read it rather than asserting big blinds: on an ICM solve every EV, regret and
   *  trainer grade is in CSTE tournament chips. */
  const payoffLabel = meta?.payoff_unit === "cste" ? "CSTE tournament chips" : "big blinds";

  const tourSteps: TourStep[] = [
    {
      id: "welcome",
      target: null,
      title: "A solved spot is already open",
      body: `This workbench opens with a real solved spot loaded: ${tourFacts ? `${tourFacts.board}, a ${tourFacts.street} spot` : "a bundled sample"}. The tour walks every panel in about two minutes. Leave any time with Escape and restart from the Tour button in the rail.`,
      prepare: () => setTab("inspect"),
    },
    {
      id: "rail",
      target: '[data-tour="rail"]',
      title: "Four tabs, one page",
      body: "Inspect the loaded solve, train against it, run a new one, or read the reference. Solutions come from the bundled samples, a file off disk, or a solve run right here. Switching tabs never loses your place.",
      prepare: () => setTab("inspect"),
    },
    {
      id: "stats",
      target: '[data-tour="statband"]',
      title: "The spot's vitals",
      body: "Board, pot, stacks, and each player's EV at the root. The club-green block is exploitability, measured by a separate best-response calculator at every report, never estimated from regret. On a tournament solve it becomes NashConv and the band gains bubble factors and the payout ladder.",
      prepare: () => {
        setTab("inspect");
        goRoot();
      },
    },
    {
      id: "line",
      target: '[data-tour="line"]',
      title: "The line you walked",
      body: "The path from the root to the node on screen. Every chip is clickable and takes you back up the line.",
      prepare: () => {
        setTab("inspect");
        goRoot();
      },
    },
    {
      id: "actions",
      target: '[data-tour="actions"]',
      title: "Actions, pre-shaded",
      body: "The legal actions at this node. Each block is already filled to the frequency the solver takes it across the whole range, so you can read the strategy before you click anything.",
      prepare: () => {
        setTab("inspect");
        goRoot();
      },
    },
    {
      id: "grid",
      target: '[data-tour="grid-strategy"]',
      title: "169 hand classes",
      body: "Each cell splits by action: red bets, green checks and calls under a 45 degree hatch, blue folds, and a darker red for a bigger sizing. Faded cells have no reach at this node; dark cells have no live combos on this board.",
      prepare: () => {
        setTab("inspect");
        goRoot();
      },
    },
    {
      id: "combo",
      target: '[data-tour="combo-panel"]',
      title: "Inside one cell",
      body: `${tourCell.label}, opened. A hand class is an average; underneath it every combo has its own mix and its own EV in ${payoffLabel}, down to the exact two cards.`,
      prepare: () => {
        setTab("inspect");
        goRoot();
        setSelected({ row: tourCell.row, col: tourCell.col });
      },
    },
    {
      id: "modes",
      target: '[data-tour="grid-mode"]',
      title: "Three lenses on the same grid",
      body: `Beyond strategy, two more lenses: EV of the best action, and regret, the ${payoffLabel} a hand gives up by mixing instead of always taking its best action. Regret shows where a mistake is cheap and where it is expensive.`,
      prepare: () => {
        setTab("inspect");
        goRoot();
        setGridMode("regret");
      },
    },
    {
      id: "side",
      target: '[data-tour="side"]',
      title: "The other seat",
      body: "The opponent's range at the same node, weighted by how often each hand actually gets here. Below it, blockers: how much holding your two cards shifts the opponent's next decision, ranked across your whole range.",
      prepare: () => {
        setTab("inspect");
        goRoot();
      },
    },
    {
      id: "lock",
      target: '[data-testid="lock-node"]',
      title: "Freeze a node",
      body: "Lock this node at the strategy on screen, then re-solve on the Solve tab: the rest of the tree becomes the counter-strategy to the locked line. Locks captured on a different spot are refused, never silently re-applied.",
      prepare: () => {
        setTab("inspect");
        goRoot();
      },
    },
    ...(tourFacts?.hasChance
      ? [
          {
            id: "runouts",
            target: '[data-tour="runouts"]',
            title: "Every runout, priced",
            body: "A chance node. Dealt cards are struck out and every live card is shaded by how much it moves hero's EV. The table ranks all runouts by consequence; pick a card, and the arrow keys then step between its sibling runouts.",
            prepare: () => {
              setTab("inspect");
              goToRunouts();
            },
          } satisfies TourStep,
        ]
      : []),
    {
      id: "train",
      target: '[data-tour="train-drill"]',
      title: "Train against the solve",
      body: `The trainer deals you hands out of a solved spot. Pick an action and it is graded on the ${payoffLabel} it costs against the solve; the full solver mix and a d100 roll are revealed after you answer. Random spot solves a fresh board right here first.`,
      prepare: () => {
        goRoot();
        setSelected(null);
        setGridMode("strategy");
        setTab("train");
      },
    },
    {
      id: "train-filters",
      target: '[data-tour="train-filters"]',
      title: "Drill exactly what you want",
      body: "Filter to one seat, close decisions only, or one exact combo like AhKd on every deal. Same board redeals on the tree that is already solved, so it costs nothing.",
      prepare: () => setTab("train"),
    },
    {
      id: "solve",
      target: '[data-tour="solve-spot"]',
      title: "Your own spot",
      body: "Start from a preset, then set the board, both ranges, stacks, pot and the bet-sizing tree. Ranges can be painted by hand, typed as range strings, or cut to a top percentage.",
      prepare: () => setTab("solve"),
    },
    {
      id: "preflight",
      target: '[data-testid="preflight"]',
      title: "Priced before it runs",
      body: "The preflight builds the tree and prices the solver's memory bill before the solve commits to it, blocking one that would crash the tab. The solve itself runs in a worker with a live exploitability curve, so the page never freezes.",
      prepare: () => setTab("solve"),
    },
    {
      id: "help",
      target: '[data-tour="help-legends"]',
      title: "Everything is written down",
      body: "Every color, grid mode and shortcut is defined on this tab. The URL carries your inspector view, tab, node and selected combo, so the spot you are studying is a shareable link. Restart this tour any time from the rail.",
      prepare: () => setTab("help"),
    },
  ];

  return (
    <div className="app">
      <a href="#main" className="skip">
        Skip to the solver
      </a>
      {/* ── RAIL ─────────────────────────────────────────────────────────── */}
      <aside className="rail" data-tour="rail">
        <a
          href="https://postflop.vercel.app"
          className="rule-b block px-3 py-3.5 max-[999px]:flex max-[999px]:items-center max-[999px]:border-b-0 max-[999px]:py-0"
        >
          <div className="flex items-center gap-2.5">
            <PlateChip />
            <span
              className="text-text"
              style={{ font: "800 19px/1 var(--font-sans)", letterSpacing: "-.03em" }}
            >
              <span className="max-[1399px]:hidden min-[1000px]:max-[1399px]:hidden">postflop</span>
              <span className="hidden min-[460px]:max-[999px]:inline">postflop</span>
            </span>
          </div>
          <div className="label mt-2 text-[9px] max-[1399px]:hidden">HU NLHE · chipEV &amp; ICM</div>
        </a>

        <nav className="flex flex-col max-[999px]:flex-1 max-[999px]:flex-row">
          {(
            [
              ["inspect", "Inspector", "inspect"],
              ["train", "Train", "train"],
              ["solve", "Solve", "solve"],
              ["help", "About", "help"],
            ] as [Tab, string, IconName][]
          ).map(([id, label, glyph]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              aria-label={label}
              className={`h-11 rule-b px-3 text-left uppercase max-[999px]:flex-1 max-[999px]:border-b-0 max-[999px]:text-center ${
                tab === id
                  ? "bg-ink text-paper"
                  : "bg-paper-2 text-dim hover:bg-raised hover:text-text"
              }`}
              style={{ font: "600 11px/2.8 var(--font-condensed)", letterSpacing: ".15em" }}
            >
              <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">{label}</span>
              <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">
                <Ico name={glyph} />
              </span>
            </button>
          ))}
          {/* Mobile tour entry: the rail's bottom button group is display:none
              below 1000px, so the tour keeps a seat in the tab strip there. */}
          <button
            data-testid="tour-button-mobile"
            disabled={!handle}
            onClick={() => setTour(0)}
            aria-label="Start the guided tour"
            title="A two-minute walk through every panel of this workbench"
            className="hidden w-12 flex-none place-items-center self-stretch bg-paper-2 text-dim hover:bg-raised hover:text-text disabled:opacity-40 max-[999px]:grid"
          >
            <Ico name="tour" />
          </button>
        </nav>

        <div className="rule-b max-[999px]:hidden min-[1000px]:max-[1399px]:hidden">
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
                <div className="label mb-1 min-[1000px]:max-[1399px]:hidden">
                  {meta.payoff_unit === "cste" ? "NASHCONV" : "EXPLOITABILITY"}
                </div>
                <div className="w-full bg-accent px-2 py-1.5 text-accent-ink">
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
                  className="btn mb-2 h-[34px] w-full"
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-auto shrink-0 max-[999px]:mt-0 max-[999px]:hidden">
          <button
            data-testid="tour-button"
            disabled={!handle}
            onClick={() => setTour(0)}
            aria-label="Start the guided tour"
            title="A two-minute walk through every panel of this workbench"
            className="btn btn-inv rule-t block h-[34px] w-full border-0"
          >
            <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">Guided tour</span>
            <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">
              <Ico name="tour" />
            </span>
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            aria-label="Open a solution file"
            className="btn btn-inv rule-t block h-[34px] w-full border-0"
            title="Open a solution file written by the solver CLI or exported from this page"
          >
            <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">Open file…</span>
            <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">
              <Ico name="open" />
            </span>
          </button>
          <button
            data-testid="export"
            disabled={!handle}
            onClick={exportJson}
            aria-label="Export solution as JSON"
            title="Export the loaded solution as a JSON file"
            className="btn btn-inv rule-t block h-[34px] w-full border-0"
          >
            <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">Export JSON</span>
            <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">
              <Ico name="export" />
            </span>
          </button>
          {locks.length > 0 && (
            <button
              data-testid="lock-count"
              onClick={() => setTab("solve")}
              aria-label={`${locks.length} node locks pending, review on the Solve tab`}
              title="Review the pending locks on the Solve tab and re-solve"
              className="btn btn-inv rule-t block h-[34px] w-full border-0"
            >
              <span aria-hidden className="min-[1000px]:max-[1399px]:hidden">{locks.length} locks pending →</span>
              <span aria-hidden className="hidden min-[1000px]:max-[1399px]:inline">{locks.length}</span>
            </button>
          )}
          {/* The law of the palette, pinned to the foot of the rail so it travels
              with the tool exactly as it stands in the site hero. */}
          <div className="ink-key max-[1399px]:hidden">
            <p className="label mb-2.5">Ink key</p>
            <div className="row">
              <span className="k">
                <b style={{ backgroundColor: "var(--color-bet)" }} />
                Bet
              </span>
              <span className="k">
                {/* `backgroundColor`, never the `background` shorthand: the shorthand
                    resets background-image and kills `.hatch`'s overprint. */}
                <b className="hatch" style={{ backgroundColor: "var(--color-check)" }} />
                Check
              </span>
              <span className="k">
                <b style={{ backgroundColor: "var(--color-fold)" }} />
                Fold
              </span>
            </div>
            <div className="row">
              <span className="pip" style={{ color: "#171a18" }}>♠</span>
              <span className="pip" style={{ color: "#c8102e" }}>♥</span>
              <span className="pip" style={{ color: "#1240c4" }}>♦</span>
              <span className="pip" style={{ color: "#00713f" }}>♣</span>
            </div>
            <p>
              <b>Inside a cell an ink is an action. On a card face it is a suit.</b> Never both in
              one rectangle. Check carries a 45° hatch, so the mix reads without colour.
            </p>
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
      <main id="main" className="stage">
        {/* One h1 per view. The Help tab prints its own, so it is skipped here rather
            than shipping two. */}
        {tab !== "help" && <h1 className="sr-only">{TAB_TITLES[tab]}</h1>}
        {error && (
          <div
            data-testid="banner"
            role="alert"
            className="flex items-center gap-3 bg-err-bg px-3.5 py-2"
            style={{ borderBottom: "var(--rule) solid var(--color-err)" }}
          >
            <span
              className="bg-ink px-2 py-1 uppercase text-paper"
              style={{ font: "600 10px/1 var(--font-condensed)", letterSpacing: ".15em" }}
            >
              Could not load
            </span>
            <span className="num text-[12px]">{error}</span>
          </div>
        )}
        {!error && loading && (
          <div
            data-testid="banner"
            className="relative bg-accent px-3.5 py-1.5 uppercase text-accent-ink"
            style={{ font: "600 11px/1.6 var(--font-condensed)", letterSpacing: ".15em" }}
          >
            reading…
            <span className="slide-rule" style={{ background: "var(--color-accent-ink)" }} />
          </div>
        )}

        {tab === "inspect" && loaded && view && meta && rootEvs && (
          <StatBand meta={meta} rootEvs={rootEvs} source={source} node={view.node} />
        )}

        {tab === "inspect" && loaded && view?.kind === "decision" && meta && rootEvs && icmCompare && (
          <IcmCompare
            actions={view.actions}
            colors={view.colors}
            icmFreqs={view.freqs}
            chipFreqs={icmCompare.chipFreqs}
            player={view.player}
            icmRootEvs={rootEvs}
            chipRootEvs={icmCompare.chipRootEvs}
            icmMeta={meta}
            chipMeta={icmCompare.chipMeta}
          />
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
            onSolved={(json, wall, ctx, chipJson) => {
              setSpotContext(ctx);
              return adopt(json, `browser solve (${wall.toFixed(2)}s)`, false, chipJson);
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
              {/* Column 1: strategy grid */}
              <section className="col-strategy flex flex-col bg-panel" data-tour="grid-strategy">
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
                      className={`border px-2 py-1.5 uppercase disabled:opacity-40 ${
                        lockedHere
                          ? "border-accent bg-accent text-accent-ink"
                          : "border-line-strong bg-raised text-text hover:bg-ink hover:text-paper"
                      }`}
                      style={{ font: "600 10px/1 var(--font-condensed)", letterSpacing: ".15em" }}
                    >
                      {lockedHere ? "lock updated" : "lock node"}
                    </button>
                    {!wide && (
                      <span className="seg" data-tour="grid-mode">
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

              {/* Column 2: EV/regret twin grid, ≥1900px only */}
              <section className="col-ev flex-col bg-panel">
                <div className="bar bar-ev">
                  {gridMode === "regret" ? "Regret surface" : "EV surface"}
                  <span className="meta">same node · same selection</span>
                  <span className="right">
                    <span className="seg" data-tour="grid-mode">
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
                  className="mt-auto rule-t bg-paper-2 px-2.5 py-2 text-[11px] text-muted"
                >
                  {LEGEND_CAPTION[gridMode === "regret" ? "regret" : "ev"]}
                </div>
              </section>

              {/* Column 3: combo breakdown */}
              <section className="col-combo flex flex-col bg-panel" data-tour="combo-panel">
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
                  unit={meta?.payoff_unit}
                  onPickCell={(c) => setSelected(c)}
                />
              </section>

              {/* Side column: opponent range + blockers */}
              <div className="col-side flex flex-col" data-tour="side">
                <section className="flex flex-col bg-panel">
                  <div className="bar bar-opp">
                    {PLAYER_NAMES[1 - view.player]} range
                    <span className="meta">{view.oppCombos.length} combos · reach-weighted</span>
                  </div>
                  <div className="p-2">
                    {/* Width cap: in the 1100–1499px full-width side row this grid would
                        otherwise stretch to half the stage and dwarf the strategy grid. */}
                    <div style={{ maxWidth: 470 }}>
                      <RangeGrid cells={view.oppCells} colors={["#5b8cff"]} mode="reach" size="small" />
                    </div>
                  </div>
                  <p className="rule-t bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
                    <span className="block max-w-[68ch]">
                    Density is that hand&apos;s reach at this node: range weight times their own
                    strategy along the line. They are not acting here, so there are no action
                    frequencies to show.
                    </span>
                  </p>
                </section>
                <section className="flex min-h-0 flex-1 flex-col rule-t bg-panel">
                  <BlockerPanel
                    cell={selectedCell}
                    combos={view.combos}
                    oppCombos={view.oppCombos}
                    oppStrategy={view.oppActionStrategy}
                    oppActions={view.oppActionNode?.actions ?? []}
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
      </main>

      {/* ── STATUS BAR ───────────────────────────────────────────────────── */}
      <footer className="statusbar on-ink flex items-center overflow-x-auto whitespace-nowrap px-2.5">
        <StatusSeg label={loaded ? `NODE ${nodeId}` : "NO SPOT"} value={loaded && view ? view.node.kind.toUpperCase() : booted ? "WASM IDLE" : "BOOTING"} />
        <StatusSeg label="COMBOS" value={view?.kind === "decision" ? view.combos.length.toLocaleString() : "0"} />
        <StatusSeg label="ITERS" value={meta ? meta.iterations.toLocaleString() : "0"} />
        <StatusSeg
          label={meta?.payoff_unit === "cste" ? "NASHCONV" : "EXPL"}
          value={meta ? `${meta.exploitability_pct_of_pot.toFixed(4)}%` : "–"}
        />
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

      {tour !== null && loaded && (
        <Tour steps={tourSteps} index={tour} onIndex={setTour} onClose={closeTour} />
      )}
    </div>
  );
}

/** One visible h1 per view, named for what the view is. */
const TAB_TITLES: Record<Tab, string> = {
  inspect: "Inspector",
  train: "Trainer",
  solve: "Solve a spot",
  help: "About this solver",
};

type IconName = "inspect" | "train" | "solve" | "help" | "tour" | "open" | "export";

/**
 * The rail's icon tier, which the 64px rail between 1000 and 1399px is the only place
 * that shows. Drawn here rather than typed as Unicode dingbats: Barlow carries none of
 * U+25A6 / U+25CE / U+2699, so those fell back per platform and one of them rendered as
 * a colour emoji. One 16px box, one 1.5px stroke, no fills.
 */
const ICON_PATHS: Record<IconName, React.ReactNode> = {
  inspect: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11" />
    </>
  ),
  train: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.7" />
    </>
  ),
  solve: (
    <>
      <path d="M2.5 5h11M2.5 11h11" />
      <path d="M6 3.2v3.6M10.5 9.2v3.6" />
    </>
  ),
  help: (
    <>
      <path d="M5.7 5.9a2.3 2.3 0 1 1 2.4 3v1" />
      <path d="M8.1 12.1h.01" strokeLinecap="round" />
    </>
  ),
  tour: (
    <>
      <path d="M2.8 8h9.4" />
      <path d="M8.6 4.4 12.2 8l-3.6 3.6" />
    </>
  ),
  open: (
    <>
      <path d="M8 2.6v7.2" />
      <path d="M5.2 7l2.8 2.8L10.8 7" />
      <path d="M2.6 13.4h10.8" />
    </>
  ),
  export: (
    <>
      <path d="M8 9.8V2.6" />
      <path d="M5.2 5.4 8 2.6l2.8 2.8" />
      <path d="M2.6 13.4h10.8" />
    </>
  ),
};

function Ico({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className="inline-block align-middle"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/**
 * The mark: a 2x2 block of the four plate inks, a printer's registration block and the
 * four suits at once. It stands in the workbench chrome and nowhere else.
 */
function PlateChip({ size = 18 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid flex-none grid-cols-2 grid-rows-2"
      style={{ width: size, height: size }}
    >
      <i style={{ background: "var(--color-ink-2)" }} />
      <i style={{ background: "var(--color-card-h)" }} />
      <i style={{ background: "var(--color-card-d)" }} />
      <i style={{ background: "var(--color-card-c)" }} />
    </span>
  );
}

/** The action set the empty-state spec sheet documents. Its swatches are painted by
 *  the real `actionColors` ramp, so the legend cannot drift from the grid. */
const SPEC_ACTIONS: NodeAction[] = [
  { label: "bet", text: "bet, smallest sizing", amount_to: 1, percent_of_pot: 25, child: 0 },
  { label: "bet", text: "bet", amount_to: 2, percent_of_pot: 50, child: 0 },
  { label: "bet", text: "bet", amount_to: 3, percent_of_pot: 75, child: 0 },
  { label: "bet", text: "bet", amount_to: 4, percent_of_pot: 125, child: 0 },
  { label: "bet", text: "bet, largest sizing", amount_to: 5, percent_of_pot: 200, child: 0 },
  { label: "check", text: "check", amount_to: null, percent_of_pot: null, child: 0 },
  { label: "call", text: "call", amount_to: null, percent_of_pot: null, child: 0 },
  { label: "fold", text: "fold", amount_to: null, percent_of_pot: null, child: 0 },
];
const SPEC_COLORS = actionColors(SPEC_ACTIONS);

function StatusSeg({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="num text-[11px] text-dim-inv">
        {label} <span className="text-text-inv">{value}</span>
      </span>
      <span aria-hidden className="mx-2.5 h-3 w-px flex-none bg-line" />
    </>
  );
}

function Booting() {
  return (
    <div className="on-ink relative flex flex-1 items-center">
      <span
        className="px-6 uppercase text-dim-inv"
        style={{ font: "600 11px/1.2 var(--font-condensed)", letterSpacing: ".15em" }}
      >
        Reading fixture-turn.json
      </span>
      <span className="slide-rule" />
    </div>
  );
}

/**
 * Stat band: the stage's one club-lit block lives here (exploitability, or NashConv).
 *
 * Under a tournament solve the game is general-sum, so the headline is the sum of both
 * players' unilateral best-response gains and is NOT a bound on either player's loss.
 * The label, the unit on every EV tile and the per-player split all follow
 * `meta.payoff_unit`; nothing here may print "exploitability" over a CSTE number.
 */
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
  const icm = meta.payoff_unit === "cste";
  const unit = icm ? "CSTE" : "BB";
  const t = meta.tournament ?? null;
  const bf = (hero: number, villain: number) => t?.bubble_factors?.[hero]?.[villain] ?? null;
  return (
    <section className="on-ink rule-b flex flex-wrap" data-tour="statband">
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
      <StatTile
        label={icm ? "NASHCONV" : "EXPLOITABILITY"}
        title={
          icm
            ? "General-sum: the sum of both players' unilateral best-response gains. Zero does not certify a minimum EV for either player."
            : "Zero-sum: what a perfect opponent could still win, measured by two full best-response walks."
        }
      >
        <span className="inline-block bg-accent px-2 py-1 text-accent-ink">
          <span className="fig fig-1">{meta.exploitability_pct_of_pot.toFixed(4)}%</span>
        </span>
        <span className="num mt-1 block text-[11px] text-dim-inv">
          {meta.exploitability_chips.toFixed(6)} {icm ? "cste" : "bb"}
          {icm && meta.gain && (
            <>
              <br />
              gain OOP {meta.gain[0].toFixed(6)} / IP {meta.gain[1].toFixed(6)}
            </>
          )}
        </span>
      </StatTile>
      <StatTile label={`ROOT EV · ZERO-SUM · ${unit}`}>
        <span className="fig fig-2">{rootEvs.zero_sum[0].toFixed(4)}</span>
        <span className="num text-dim-inv"> / {rootEvs.zero_sum[1].toFixed(4)}</span>
        {icm && (
          <span
            className="num mt-1 block text-[11px] text-dim-inv"
            title="Malmuth-Harville equity is concave in chips: the pair loses equity to the frozen field when the hand pushes their two stacks apart, and takes equity back from it when the hand pulls them together. What never holds is a constant sum."
          >
            not zero-sum: equity leaks to or from the field
          </span>
        )}
      </StatTile>
      <StatTile label={`ROOT EV · ${icm ? "SEAT EQUITY" : "POT-SHARE"}`}>
        <span className="fig fig-2">{rootEvs.pot_share[0].toFixed(4)}</span>
        <span className="num text-dim-inv"> / {rootEvs.pot_share[1].toFixed(4)}</span>
      </StatTile>
      {icm && t && (
        <StatTile
          label="BUBBLE FACTOR"
          title="How many chips of equity the hero risks per chip they can win against this villain. 1.00 is chipEV; above it, calling needs more than pot odds."
        >
          <span className="fig fig-2">{fmtBf(bf(t.seats[0], t.seats[1]))}</span>
          <span className="num text-dim-inv"> / {fmtBf(bf(t.seats[1], t.seats[0]))}</span>
          <span className="num mt-1 block text-[11px] text-dim-inv">
            OOP / IP · needs {fmtEq(bf(t.seats[0], t.seats[1]))} / {fmtEq(bf(t.seats[1], t.seats[0]))} equity
          </span>
        </StatTile>
      )}
      {icm && t && (
        <StatTile label="STRUCTURE">
          <div className="num text-[12px] leading-snug text-text-inv">
            {t.stacks.length} seats · {t.payouts.length} paid
            <br />
            pays {t.payouts.map((v) => trim(v)).join(" / ")}
            <br />
            seat {t.seats[0]} ({trim(t.stacks[t.seats[0]])}) vs seat {t.seats[1]} (
            {trim(t.stacks[t.seats[1]])})
          </div>
        </StatTile>
      )}
      <StatTile label="SOLVE">
        <div className="num text-[12px] leading-snug text-text-inv">
          {/* Each group is atomic: the tile is only ~150px, and without this the
              browser breaks between "engine" and its version, or drops the second
              word of the source name onto a line of its own. */}
          <span className="whitespace-nowrap">{meta.iterations.toLocaleString()} iters</span>{" "}
          <span className="whitespace-nowrap">· {meta.wall_seconds.toFixed(3)} s</span>{" "}
          <span className="whitespace-nowrap">· engine {meta.engine_version}</span>
          <br />
          <span className="whitespace-nowrap">{meta.node_count.toLocaleString()} nodes</span>
          {source ? <> <span className="whitespace-nowrap">· {source}</span></> : null}
        </div>
      </StatTile>
    </section>
  );
}

function StatTile({
  label,
  first = false,
  wide = false,
  title,
  children,
}: {
  label: string;
  first?: boolean;
  wide?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${wide ? "min-w-[230px]" : "min-w-[150px]"} flex-1 overflow-hidden px-3.5 py-2.5`}
      style={first ? undefined : { borderLeft: "var(--rule) solid var(--color-line)" }}
      title={title}
    >
      <div className="label mb-1">{label}</div>
      {children}
    </div>
  );
}

/** A bubble factor the engine could not put a finite number on, a seat that already
 *  holds every prize the structure pays, prints as a dash, never a silent 0 or Infinity. */
const fmtBf = (v: number | null) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(3));
/** `bf / (bf + 1)`: the raw equity a symmetric all-in needs to break even at that factor. */
const fmtEq = (v: number | null) =>
  v == null || !Number.isFinite(v) ? "–" : `${((100 * v) / (v + 1)).toFixed(1)}%`;
/** Drop the trailing `.00` on a whole-number stack or prize. */
const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/**
 * chipEV beside ICM, at the node on screen.
 *
 * This is the whole point of solving the twin: the same tree, the same iterations, the
 * only difference being what a chip is worth at the end of it. The per-action range
 * frequency delta is the lesson every published ICM article is shaped around, and the
 * headline row underneath says what it cost: the chip solve's number is in big blinds
 * and the ICM solve's in CSTE chips, which is why they are labelled, not subtracted.
 */
function IcmCompare({
  actions,
  colors,
  icmFreqs,
  chipFreqs,
  player,
  icmRootEvs,
  chipRootEvs,
  icmMeta,
  chipMeta,
}: {
  actions: NodeAction[];
  colors: string[];
  icmFreqs: number[];
  chipFreqs: number[];
  player: 0 | 1;
  icmRootEvs: RootEvs;
  chipRootEvs: RootEvs;
  icmMeta: Meta;
  chipMeta: Meta;
}) {
  const biggest = actions.reduce(
    (best, _a, i) =>
      Math.abs(icmFreqs[i] - chipFreqs[i]) > Math.abs(icmFreqs[best] - chipFreqs[best]) ? i : best,
    0,
  );
  const pts = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    <section className="rule-b bg-panel" data-testid="icm-compare">
      <h2 className="bar bar-icm">
        chipEV vs ICM · {PLAYER_NAMES[player]} at this node
        <span className="meta">
          same tree, same iterations, only what a chip is worth at the end differs · biggest
          move {actions[biggest]?.text}{" "}
          {((icmFreqs[biggest] - chipFreqs[biggest]) * 100 >= 0 ? "+" : "") +
            ((icmFreqs[biggest] - chipFreqs[biggest]) * 100).toFixed(1)}{" "}
          pts
        </span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 480 }}>
          <thead>
            <tr>
              {["action", "chipEV", "ICM", "Δ pts"].map((h, i) => (
                <th
                  key={h}
                  className="label"
                  style={{
                    textAlign: i === 0 ? "left" : "right",
                    padding: "5px 10px",
                    borderBottom: "var(--rule-thin) solid var(--color-line)",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {actions.map((a, i) => {
              const d = (icmFreqs[i] - chipFreqs[i]) * 100;
              return (
                <tr key={a.child} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                  <td style={{ padding: "4px 10px" }}>
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        marginRight: 7,
                        background: colors[i],
                      }}
                    />
                    <span className="num text-[12px]">{a.text}</span>
                  </td>
                  <td className="num text-right text-[12px] text-muted" style={{ padding: "4px 10px" }}>
                    {pts(chipFreqs[i])}
                  </td>
                  <td className="num text-right text-[12px]" style={{ padding: "4px 10px" }}>
                    {pts(icmFreqs[i])}
                  </td>
                  <td
                    className="num text-right text-[12px]"
                    style={{
                      padding: "4px 10px",
                      background: i === biggest ? "var(--color-accent)" : undefined,
                      color: i === biggest ? "var(--color-accent-ink)" : undefined,
                      fontWeight: i === biggest ? 700 : undefined,
                    }}
                  >
                    {d >= 0 ? "+" : ""}
                    {d.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="bg-paper-2 px-2.5 py-2 text-[11px] text-muted" style={{ borderTop: "var(--rule-thin) solid var(--color-line)" }}>
        Root EV, {PLAYER_NAMES[0]} / {PLAYER_NAMES[1]}: chipEV{" "}
        <span className="num">
          {chipRootEvs.zero_sum[0].toFixed(4)} / {chipRootEvs.zero_sum[1].toFixed(4)} bb
        </span>{" "}
        at exploitability <span className="num">{chipMeta.exploitability_pct_of_pot.toFixed(4)}%</span>
        {" · "}ICM{" "}
        <span className="num">
          {icmRootEvs.zero_sum[0].toFixed(4)} / {icmRootEvs.zero_sum[1].toFixed(4)} cste
        </span>{" "}
        at NashConv <span className="num">{icmMeta.exploitability_pct_of_pot.toFixed(4)}%</span>. The
        two EVs are in different units and are not comparable; the frequencies above are.
      </p>
    </section>
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
      <section className="flex min-h-0 flex-col overflow-y-auto bg-panel" data-tour="runouts">
        <h2 className="bar">
          Deal the {nextStreet}
          <span className="meta">
            {valid.length} of 52 available · {node.board.length} on board
          </span>
        </h2>
        {/* Top-aligned, not centred: vertical centring left a dead band above the
            lattice as well as below it, and this identity fills a column from its
            own panel head down. */}
        <div className="flex flex-1 items-start justify-center p-6">
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
        <div className="grid grid-cols-[64px_1fr_1fr] rule-b bg-paper-2 px-2.5 py-1.5">
          <span className="label">card</span>
          <span className="label text-right">hero EV</span>
          <span className="label text-right">vs mean</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((r, i) => (
            <button
              key={r.card}
              onClick={() =>
                onStep({ from: node.id, to: r.child, kind: "chance", label: `${nextStreet} ${r.card}`, token: r.card })
              }
              /* Hover is the system's one selection move: a full knock-out to stock
                 white, every child forced to the plate ground. A colour fill here would
                 have to carry the suit ink and the ok/err deviation, and neither reads. */
              className={`grid h-[26px] w-full grid-cols-[64px_1fr_1fr] items-center px-2.5 text-left hover:bg-ink [&:hover>*]:text-paper ${
                i % 2 === 1 ? "bg-paper-2" : ""
              }`}
            >
              <Card card={r.card} className="text-[13px]" />
              <span className="num text-right">{Number.isNaN(r.ev) ? "–" : r.ev.toFixed(3)}</span>
              <span
                className={`num text-right ${Number.isNaN(r.dev) ? "text-dim" : r.dev >= 0 ? "text-ok" : "text-err"}`}
              >
                {Number.isNaN(r.dev) ? "–" : `${r.dev >= 0 ? "+" : ""}${r.dev.toFixed(3)}`}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Terminal node: the hand is over: a poster, not a hint sentence. */
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
      <div style={{ font: "800 clamp(32px,4vw,64px)/1 var(--font-sans)", letterSpacing: "-.03em", textWrap: "balance" }}>
        {t?.kind === "fold" ? `${PLAYER_NAMES[t.folder]} folds` : "Showdown"}
      </div>
      <div className="label mt-6">POT · BB</div>
      <div className="fig fig-1">{t?.pot.toFixed(2)}</div>
      <p className="mt-6 text-muted">
        No strategy here. Step back up the line to keep inspecting.
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
  ev: "color = highest-EV action · palest = near-indifferent · dark = no EV data",
  regret: "color = bb lost vs the best action · palest = no regret · dark = no EV data",
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
    <div className="mt-auto flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rule-t bg-paper-2 px-2.5 py-2">
      {actions.map((a, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span
            className={`h-[11px] w-[11px] ${hatched(a.label) ? "hatch" : ""}`}
            style={{ backgroundColor: colors[i] }}
          />
          <span className="num text-[12px]">{a.text}</span>
          <span className="num" style={{ fontWeight: 700 }}>
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
 * failed to parse: three full-bleed rows: poster headline, four entry slabs, and a
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
      {/* Row 1: poster headline */}
      <div className="rule-b bg-panel" style={{ padding: "clamp(24px,3vw,56px)" }}>
        <h1 style={{ font: "800 clamp(44px,5.4vw,96px)/0.98 var(--font-sans)", letterSpacing: "-.03em", textWrap: "balance" }}>
          No solution{" "}
          <span className="bg-accent text-accent-ink" style={{ padding: "0 .12em" }}>
            loaded
          </span>
        </h1>
        <p className="mt-4 max-w-[74ch] text-[14px] text-muted">
          Load a solution file, pick a bundled sample, or solve a spot in the browser. Loading
          rebuilds the tree and reads stored strategies, it never re-solves.
        </p>
        {error && (
          <p className="num mt-3 text-[13px] text-err">
            <span
              className="mr-2 bg-ink px-2 py-0.5 uppercase text-paper"
              style={{ font: "600 10px/1.6 var(--font-condensed)", letterSpacing: ".15em" }}
            >
              could not load
            </span>
            {error}
          </p>
        )}
      </div>

      {/* Row 2: four entry slabs */}
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
                className="text-text"
                style={{ font: "800 clamp(24px,2vw,36px)/1 var(--font-sans)", letterSpacing: "-.03em" }}
              >
                {s.name}
              </div>
              <div className="num text-[12px] text-dim-inv">{s.detail}</div>
            </div>
            <button
              data-testid={`empty-sample-${s.file}`}
              onClick={() => onSample(s.file, s.name)}
              className="h-11 w-full bg-raised uppercase text-text hover:bg-ink hover:text-paper"
              style={{ font: "600 12px/1 var(--font-condensed)", letterSpacing: ".15em" }}
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
            dragging ? "bg-accent text-accent-ink [&_*]:text-accent-ink" : "bg-panel"
          }`}
          style={{ outline: "2px dashed var(--color-line)", outlineOffset: "-12px" }}
        >
          <span style={{ font: "800 clamp(22px,1.8vw,30px)/1 var(--font-sans)", letterSpacing: "-.03em" }}>
            Open file…
          </span>
          <span className="text-[12px] text-muted">
            A solution written by the CLI, or exported from this page. Drop it anywhere on this
            block.
          </span>
        </button>
        <button
          onClick={onSolveTab}
          className="rule-l flex min-w-[280px] flex-1 basis-1/2 flex-col items-start justify-center gap-3 bg-accent p-5 text-left text-accent-ink min-[1500px]:basis-0 max-[1499px]:rule-t"
        >
          <span style={{ font: "800 clamp(22px,1.8vw,30px)/1 var(--font-sans)", letterSpacing: "-.03em" }}>
            Solve a new spot →
          </span>
          <span className="text-[12px]">
            Set a board, two ranges and a sizing tree; the engine runs as WebAssembly on this page.
          </span>
        </button>
      </div>

      {/* Row 3: spec sheet */}
      <div className="grid min-h-0 grid-cols-1 min-[1000px]:grid-cols-[380px_minmax(0,1fr)] min-[1280px]:grid-cols-[380px_repeat(3,minmax(0,1fr))]">
        <div className="bg-panel p-4">
          <div style={{ display: "grid", gridTemplateColumns: "var(--axis) repeat(13, minmax(0,1fr))", gap: 2, padding: 2, background: "var(--color-line)" }}>
            <span />
            {"AKQJT98765432".split("").map((r) => (
              <span key={`c${r}`} className="flex items-center justify-center" style={{ font: "700 8px/1 var(--font-mono)", color: "var(--color-dim-inv)", minHeight: "var(--axis)" }}>
                {r}
              </span>
            ))}
            {Array.from({ length: 169 }, (_, i) => {
              const row = Math.floor(i / 13);
              const col = i % 13;
              const fill =
                row === col
                  ? "var(--color-plate-d)"
                  : row < col
                    ? "var(--color-plate-c)"
                    : "var(--color-ink-2)";
              return (
                <Fragment169 key={i} first={col === 0} rank={"AKQJT98765432"[row]}>
                  <span
                    className="flex aspect-square items-center justify-center"
                    style={{ background: fill, font: "700 8px/1 var(--font-mono)", color: "var(--color-text)" }}
                  >
                    {cellLabel(row, col)}
                  </span>
                </Fragment169>
              );
            })}
          </div>
          <div className="label mt-2">169 hand classes · 1,326 combinations</div>
          <p className="mt-1 text-[11px] text-muted">
            Six combinations per pair on the diagonal, four per suited hand above it, twelve per
            offsuit hand below. Every cell opens a combo breakdown.
          </p>
        </div>
        <SpecCol title="Action colors">
          {SPEC_ACTIONS.map((a, i) => (
            <div key={a.text + i} className="flex items-center gap-2.5 py-1">
              <span
                className={`h-[11px] w-[11px] ${hatched(a.label) ? "hatch" : ""}`}
                style={{ backgroundColor: SPEC_COLORS[i] }}
              />
              <span className="num text-[12px]">{a.text}</span>
            </div>
          ))}
          <p className="mt-2 text-[11px] text-muted">
            Colors are consistent in every grid, table and tree block on this page.
          </p>
        </SpecCol>
        <SpecCol title="Grid modes">
          {(
            [
              ["strategy", [SPEC_COLORS[2], SPEC_COLORS[5], SPEC_COLORS[7]]],
              ["ev", [1, 0.5, 0.12].map((t) => rampMix(SPEC_COLORS[2], t))],
              ["regret", [0, 0.5, 1].map((t) => regretColor(t, 1) ?? SPEC_COLORS[2])],
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
