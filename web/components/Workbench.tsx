"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BlockerPanel from "@/components/BlockerPanel";
import ComboPanel from "@/components/ComboPanel";
import RangeGrid from "@/components/RangeGrid";
import SolvePanel from "@/components/SolvePanel";
import TrainPanel from "@/components/TrainPanel";
import TreeNav, { BoardStrip } from "@/components/TreeNav";
import Help from "@/components/Help";
import {
  Cell,
  CellEv,
  RunoutHotness,
  actionColors,
  buildEvGrid,
  buildGrid,
  buildRunoutHotness,
  rangeFreqs,
} from "@/lib/grid";
import { lineOf, spotKey, type NodeLock } from "@/lib/config";
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

const SAMPLES = [
  { file: "fixture-turn.json", name: "Turn spot", detail: "Qs Jh 2h 8c · 772 decision nodes" },
  { file: "fixture-river.json", name: "River spot", detail: "Ks 7d 2c 8h 3d · 5 decision nodes" },
];

export default function Workbench() {
  const [handle, setHandle] = useState<SolutionHandle | null>(null);
  const [source, setSource] = useState<string>("");
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

  const adopt = useCallback((json: string, label: string) => {
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
        setTab("inspect");
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  const loadSample = async (file: string, name: string) => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/fixtures/${file}`);
      if (!res.ok) throw new Error(`could not fetch ${file}: HTTP ${res.status}`);
      await adopt(await res.text(), name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    await adopt(await f.text(), f.name);
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
      const idx = parent.valid_cards.findIndex((v) => v.child === last.to);
      if (idx < 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = parent.valid_cards[(idx + dir + parent.valid_cards.length) % parent.valid_cards.length];
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex items-baseline gap-2.5">
            <a href="https://postflop.vercel.app" className="text-[15px] font-semibold tracking-tight">
              <span className="text-accent">♠</span> postflop
            </a>
            <span className="hidden text-dim sm:inline">HU NLHE postflop workbench</span>
          </div>

          <nav className="flex gap-px overflow-hidden rounded border border-line">
            {(
              [
                ["inspect", "Inspector"],
                ["train", "Train"],
                ["solve", "Solve"],
                ["help", "About"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-1 ${
                  tab === id ? "bg-accent font-semibold text-ink" : "bg-raised text-muted hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {SAMPLES.map((s) => (
              <button
                key={s.file}
                data-testid={`sample-${s.file}`}
                onClick={() => loadSample(s.file, s.name)}
                title={s.detail}
                className="rounded border border-line bg-raised px-2.5 py-1 hover:border-accent-dim"
              >
                {s.name}
              </button>
            ))}
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded border border-line bg-raised px-2.5 py-1 hover:border-accent-dim"
            >
              Open file…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <button
              data-testid="export"
              disabled={!handle}
              onClick={exportJson}
              className="rounded border border-accent-dim bg-[#1c1608] px-2.5 py-1 text-accent hover:bg-[#2a2110] disabled:opacity-30"
            >
              Export JSON
            </button>
          </div>
        </div>

        {(error || loading) && (
          <div
            data-testid="banner"
            className={`px-4 py-1.5 ${
              error ? "border-t border-[#7a2b25] bg-[#1e0e0c] text-card-h" : "bg-raised text-muted"
            }`}
          >
            {error ? `Could not load that solution: ${error}` : "reading…"}
          </div>
        )}
      </header>

      <div hidden={tab !== "help"}>
        <Help />
      </div>
      {/* Kept mounted: unmounting on the tab switch would throw away the progress curve
          of the solve that just finished, which is exactly when it is worth reading. */}
      <div hidden={tab !== "solve"}>
        <SolvePanel
          locks={locks}
          onRemoveLock={(l) => setLocks((ls) => ls.filter((x) => x.line !== l))}
          onClearLocks={() => setLocks([])}
          onSolved={(json, wall) => adopt(json, `browser solve (${wall.toFixed(2)}s)`)}
        />
      </div>
      {/* Kept mounted for the same reason as the solve panel: switching to the inspector
          to review a hand must not throw away the session's score and played-hands list. */}
      <div hidden={tab !== "train"}>
        <TrainPanel
          handle={handle}
          onReview={(node, cell) => {
            setNodeId(node);
            setPath([]);
            setSelected(cell);
            setTab("inspect");
          }}
        />
      </div>

      {tab === "inspect" &&
        (!handle || !view || !meta || !rootEvs ? (
          <Empty onSample={loadSample} />
        ) : (
          <main className="flex flex-1 flex-col gap-3 p-3">
            <Overview meta={meta} rootEvs={rootEvs} source={source} node={view.node} />

            <TreeNav
              node={view.node}
              path={path}
              freqs={view.kind === "decision" ? view.freqs : []}
              colors={view.kind === "decision" ? view.colors : []}
              onStep={step}
              onJump={jump}
              hotness={runoutHotness}
            />

            {view.kind === "decision" ? (
              <div className="grid flex-1 gap-3 xl:grid-cols-[minmax(360px,480px)_minmax(0,1fr)_230px]">
                <section className="panel flex h-fit flex-col overflow-hidden">
                  <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
                    <span className="font-semibold">
                      {PLAYER_NAMES[view.player]} strategy
                      <span className="ml-2 font-normal text-dim">
                        {view.combos.length} combos · node {view.node.id}
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        data-testid="lock-node"
                        disabled={!pathLeadsHere}
                        onClick={lockCurrentNode}
                        title={
                          pathLeadsHere
                            ? "Freeze this node at the strategy shown and solve the rest of the tree around it, on the next solve."
                            : "Walk down from root to lock a node — a deep link lands here without a line."
                        }
                        className={`rounded border px-2 py-0.5 text-[11px] disabled:opacity-30 ${
                          lockedHere
                            ? "border-accent-dim bg-[#1c1608] text-accent"
                            : "border-line bg-raised text-muted hover:border-accent-dim hover:text-text"
                        }`}
                      >
                        {lockedHere ? "🔒 lock updated" : "🔒 lock this node"}
                      </button>
                      {locks.length > 0 && (
                        <button
                          data-testid="lock-count"
                          onClick={() => setTab("solve")}
                          title="Review the pending locks on the Solve tab and re-solve"
                          className="rounded border border-line bg-raised px-2 py-0.5 text-[11px] text-muted hover:border-accent-dim hover:text-text"
                        >
                          {locks.length} pending →
                        </button>
                      )}
                      <div className="flex gap-px overflow-hidden rounded border border-line text-[11px]">
                        {(["strategy", "ev", "regret"] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => setGridMode(m)}
                            className={`px-2 py-0.5 ${
                              gridMode === m
                                ? "bg-accent font-semibold text-ink"
                                : "bg-raised text-muted hover:text-text"
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                      <span className="num text-dim">{view.node.street}</span>
                    </div>
                  </div>
                  <div className="p-2">
                    <RangeGrid
                      cells={view.cells}
                      colors={view.colors}
                      mode={gridMode}
                      evCells={view.evCells}
                      actions={view.actions}
                      size="large"
                      selected={selected}
                      onSelect={(c) => setSelected({ row: c.row, col: c.col })}
                    />
                  </div>
                  <Legend actions={view.actions} colors={view.colors} freqs={view.freqs} mode={gridMode} />
                </section>

                <section className="min-h-[320px] xl:h-[calc(100vh-260px)]">
                  <ComboPanel
                    cell={selectedCell}
                    combos={view.combos}
                    strategy={view.strategy}
                    evs={view.evs}
                    actionEvs={view.actionEvs}
                    actions={view.actions}
                    colors={view.colors}
                    player={PLAYER_NAMES[view.player]}
                  />
                </section>

                <section className="panel flex h-fit flex-col overflow-hidden">
                  <div className="border-b border-line px-3 py-2">
                    <span className="font-semibold">{PLAYER_NAMES[1 - view.player]} range</span>
                    <div className="text-dim">
                      {view.oppCombos.length} combos · reach-weighted
                    </div>
                  </div>
                  <div className="p-2">
                    <RangeGrid
                      cells={view.oppCells}
                      colors={["#4a7fc1"]}
                      mode="reach"
                      size="small"
                    />
                  </div>
                  <p className="border-t border-line px-3 py-2 text-[11px] text-dim">
                    Density is that hand&apos;s reach at this node — range weight times their own
                    strategy along the line. They are not acting here, so there are no action
                    frequencies to show.
                  </p>
                </section>
              </div>
            ) : (
              <div className="panel flex items-center justify-center px-8 py-12 text-dim">
                {view.node.kind === "chance"
                  ? "Chance node — pick a runout card above to keep walking."
                  : "Terminal node — the hand is over on this line."}
              </div>
            )}

            {view.kind === "decision" && (
              <BlockerPanel
                cell={selectedCell}
                combos={view.combos}
                oppCombos={view.oppCombos}
                oppStrategy={view.oppActionStrategy}
                oppActions={view.oppActionNode?.actions ?? []}
                oppColors={view.oppActionColors}
                oppPlayer={PLAYER_NAMES[1 - view.player]}
              />
            )}
          </main>
        ))}
    </div>
  );
}

function Overview({
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
    <section className="panel grid gap-x-6 gap-y-2 px-3 py-2.5 md:grid-cols-[auto_auto_auto_1fr]">
      <div>
        <div className="label mb-1">node</div>
        <div className="flex items-center gap-3">
          <BoardStrip board={node.board} />
          <span className="num text-muted">
            pot <span className="text-text">{node.pot.toFixed(2)}</span>
          </span>
          <span className="num text-muted">
            stacks{" "}
            <span className="text-text">
              {node.stacks[0].toFixed(2)} / {node.stacks[1].toFixed(2)}
            </span>
          </span>
        </div>
      </div>

      <div>
        <div className="label mb-1">exploitability</div>
        <div className="num">
          <span className="font-semibold text-accent">
            {meta.exploitability_pct_of_pot.toFixed(4)}%
          </span>
          <span className="text-dim"> of pot · {meta.exploitability_chips.toFixed(6)} chips</span>
        </div>
      </div>

      <div>
        <div className="label mb-1">root EV per hand</div>
        <div className="num text-muted">
          zero-sum{" "}
          <span className="text-text">
            {rootEvs.zero_sum[0].toFixed(4)} / {rootEvs.zero_sum[1].toFixed(4)}
          </span>
          <span className="mx-2 text-dim">|</span>
          pot-share{" "}
          <span className="text-text">
            {rootEvs.pot_share[0].toFixed(4)} / {rootEvs.pot_share[1].toFixed(4)}
          </span>
        </div>
      </div>

      <div className="md:text-right">
        <div className="label mb-1">solve</div>
        <div className="num text-dim">
          {meta.iterations.toLocaleString()} iters · {meta.wall_seconds.toFixed(3)} s · engine{" "}
          {meta.engine_version} · {meta.node_count.toLocaleString()} nodes
          {source && <span className="ml-2 text-muted">[{source}]</span>}
        </div>
      </div>
    </section>
  );
}

const LEGEND_CAPTION: Record<"strategy" | "ev" | "regret", string> = {
  strategy: "cells weighted by live combo reach · faded = zero reach · dark = no live combos",
  ev: "color = highest-EV action · white = near-indifferent · dark = no EV data",
  regret: "color = chips lost vs. the best action · white = no regret · dark = no EV data",
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
    <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2">
      {actions.map((a, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[2px]" style={{ background: colors[i] }} />
          <span className="num">{a.text}</span>
          <span className="num text-dim">{((freqs[i] ?? 0) * 100).toFixed(1)}%</span>
        </span>
      ))}
      <span className="ml-auto text-[11px] text-dim">{LEGEND_CAPTION[mode]}</span>
    </div>
  );
}

function Empty({ onSample }: { onSample: (file: string, name: string) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="panel max-w-lg p-6">
        <h1 className="mb-1 text-lg font-semibold">Load a solution</h1>
        <p className="mb-4 text-muted">
          Open a solution file written by the <span className="num">solver</span> CLI or exported
          from this page, or start from one of the bundled samples. Loading rebuilds the game tree
          and reads the stored strategies — it never re-solves.
        </p>
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s.file}
              data-testid={`empty-sample-${s.file}`}
              onClick={() => onSample(s.file, s.name)}
              className="rounded border border-line bg-raised px-3 py-2 text-left hover:border-accent-dim"
            >
              <div className="font-semibold">{s.name}</div>
              <div className="num text-[11px] text-dim">{s.detail}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
