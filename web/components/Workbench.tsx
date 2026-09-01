"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import ComboPanel from "@/components/ComboPanel";
import RangeGrid from "@/components/RangeGrid";
import SolvePanel from "@/components/SolvePanel";
import TreeNav, { BoardStrip } from "@/components/TreeNav";
import Help from "@/components/Help";
import {
  Cell,
  actionColors,
  buildGrid,
  rangeFreqs,
} from "@/lib/grid";
import type { Combo, Meta, NodeAction, NodeInfo, PathStep, RootEvs } from "@/lib/types";
import { PLAYER_NAMES } from "@/lib/types";
import { loadWasm, type SolutionHandle } from "@/lib/wasm";

type Tab = "inspect" | "solve" | "help";

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
      oppCells: Cell[];
      oppCombos: Combo[];
      freqs: number[];
    };

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
  const [tab, setTab] = useState<Tab>("inspect");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The handle currently owned by this component, so it can be freed exactly once. */
  const live = useRef<SolutionHandle | null>(null);

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
        setNodeId(0);
        setPath([]);
        setSelected(null);
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
    const oppCombos = JSON.parse(handle.combos(nodeId, 1 - player)) as Combo[];

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
      cells: buildGrid(combos, strategy, numActions),
      // Opponent grid is reach density only — they are not the one choosing here.
      oppCells: buildGrid(oppCombos, new Float32Array(0), 0),
      oppCombos,
      freqs: rangeFreqs(combos, strategy, numActions),
    };
  }, [handle, nodeId]);

  const step = (s: PathStep) => {
    setPath((p) => [...p, s]);
    setNodeId(s.to);
    setSelected(null);
  };
  const jump = (depth: number) => {
    setPath((p) => p.slice(0, depth));
    setNodeId(depth === 0 ? 0 : path[depth - 1].to);
    setSelected(null);
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
            <span className="text-[15px] font-semibold tracking-tight">
              <span className="text-accent">◆</span> Solver
            </span>
            <span className="hidden text-dim sm:inline">HU NLHE postflop workbench</span>
          </div>

          <nav className="flex gap-px overflow-hidden rounded border border-line">
            {(
              [
                ["inspect", "Inspector"],
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
        <SolvePanel onSolved={(json, wall) => adopt(json, `browser solve (${wall.toFixed(2)}s)`)} />
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
                    <span className="num text-dim">{view.node.street}</span>
                  </div>
                  <div className="p-2">
                    <RangeGrid
                      cells={view.cells}
                      colors={view.colors}
                      mode="strategy"
                      size="large"
                      selected={selected}
                      onSelect={(c) => setSelected({ row: c.row, col: c.col })}
                    />
                  </div>
                  <Legend actions={view.actions} colors={view.colors} freqs={view.freqs} />
                </section>

                <section className="min-h-[320px] xl:h-[calc(100vh-260px)]">
                  <ComboPanel
                    cell={selectedCell}
                    combos={view.combos}
                    strategy={view.strategy}
                    evs={view.evs}
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

function Legend({
  actions,
  colors,
  freqs,
}: {
  actions: NodeAction[];
  colors: string[];
  freqs: number[];
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
      <span className="ml-auto text-[11px] text-dim">
        cells weighted by live combo reach · faded = zero reach · dark = no live combos
      </span>
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
