"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RangeEditor from "@/components/RangeEditor";
import {
  DEFAULT_FORM,
  EMPTY_CONTEXT,
  HARD_BYTES,
  type NodeLock,
  PRESETS,
  SEATS,
  STREETS,
  type SeatProfile,
  SolveForm,
  type SpotContext,
  WARN_BYTES,
  findPresetId,
  loadForm,
  saveForm,
  spotKey,
  toToml,
} from "@/lib/config";
import { fmtBytes } from "@/lib/grid";
import { randomFlop } from "@/lib/range";
import type { TreeStats } from "@/lib/types";

interface Report {
  iter: number;
  chips: number;
  pct: number;
}

type Gate = null | "warn" | "hard";

interface Props {
  onSolved: (json: string, wall: number, context: SpotContext) => void;
  /** Nodes the inspector asked to freeze; emitted as `[[locks]]` on the next solve. */
  locks: NodeLock[];
  onRemoveLock: (line: string) => void;
  onClearLocks: () => void;
}

/** Sub-grouping frame inside a column: a 2px ink box, never a soft card. */
const BOX: React.CSSProperties = {
  border: "var(--rule-thin) solid var(--color-ink)",
  padding: 10,
};

export default function SolvePanel({ onSolved, locks, onRemoveLock, onClearLocks }: Props) {
  /** The form as the user left it last session, falling back to the first preset. */
  const [form, setForm] = useState<SolveForm>(() => loadForm() ?? DEFAULT_FORM);
  /** Which preset the form still matches, `""` once anything has been hand-edited. */
  const [presetId, setPresetId] = useState(() => findPresetId(form));

  useEffect(() => saveForm(form), [form]);
  // The preflight is kept with the lock list it measured. Adding or dropping a lock
  // doesn't change the memory bill, but it does change whether the config's locks
  // resolve -- and `stats.locks` is exactly where that shows -- so a report taken under
  // a different lock list is stale. Derived, not an effect: `locks` is a fresh array
  // from the Inspector on every change, so identity is the whole test.
  const [measured, setMeasured] = useState<{ locks: NodeLock[]; stats: TreeStats } | null>(null);
  const stats = measured && measured.locks === locks ? measured.stats : null;
  const setStats = (s: TreeStats | null) => setMeasured(s ? { locks, stats: s } : null);
  const [gate, setGate] = useState<Gate>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState<"" | "preflight" | "solving">("");
  const [error, setError] = useState<string | null>(null);
  const [wall, setWall] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(1);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const worker = () => {
    if (!workerRef.current) {
      workerRef.current = new Worker("/solve-worker.js", { type: "module" });
    }
    return workerRef.current;
  };

  /** One request/response round trip against the worker, progress messages streamed out. */
  const ask = useCallback(
    (payload: Record<string, unknown>, onProgress?: (r: Report) => void) =>
      new Promise<{ stats?: string; json?: string; wall?: number }>((resolve, reject) => {
        const id = nextId.current++;
        const w = worker();
        const handler = (e: MessageEvent) => {
          const m = e.data;
          if (m.id !== id) return;
          if (m.kind === "progress") return onProgress?.({ iter: m.iter, chips: m.chips, pct: m.pct });
          w.removeEventListener("message", handler);
          if (m.kind === "error") reject(new Error(m.message));
          else resolve(m);
        };
        w.addEventListener("message", handler);
        w.addEventListener("error", (e) => reject(new Error(e.message || "worker failed")), { once: true });
        w.postMessage({ id, ...payload });
      }),
    [],
  );

  const edit = (fn: (f: SolveForm) => SolveForm) => {
    setForm((f) => fn(structuredClone(f)));
    setPresetId("");
    setStats(null);
    setGate(null);
    setError(null);
  };

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    edit(() => structuredClone(preset.form));
    setPresetId(id);
  };

  const preflight = async (toml: string) => {
    const res = await ask({ kind: "stats", toml });
    const s = JSON.parse(res.stats!) as TreeStats;
    setStats(s);
    return s;
  };

  const run = async (confirmed: boolean) => {
    setError(null);
    let toml: string;
    try {
      toml = toToml(form, locks);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      return;
    }

    try {
      setBusy("preflight");
      const s = stats ?? (await preflight(toml));
      if (!confirmed && s.total_bytes > HARD_BYTES) {
        setGate("hard");
        setBusy("");
        return;
      }
      if (!confirmed && s.total_bytes > WARN_BYTES) {
        setGate("warn");
        setBusy("");
        return;
      }
      setGate(null);
      setReports([]);
      setWall(null);
      setBusy("solving");
      const res = await ask(
        {
          kind: "solve",
          toml,
          maxIterations: Math.max(1, Number(form.max_iterations)),
          targetPct: Number(form.target_pct),
          reportEvery: Math.max(1, Number(form.report_every)),
        },
        (r) => setReports((prev) => [...prev, r]),
      );
      setWall(res.wall ?? 0);
      onSolved(res.json!, res.wall ?? 0, form.context ?? EMPTY_CONTEXT);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy("");
    }
  };

  const justPreflight = async () => {
    setError(null);
    try {
      setBusy("preflight");
      await preflight(toToml(form, locks));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="solve-shell">
      <section className="col-spot pb-2" data-tour="solve-spot">
        <div className="bar">
          spot
          <span className="right" style={{ flex: 1, minWidth: 0 }}>
            <select
              value={presetId}
              data-testid="preset-select"
              aria-label="spot preset"
              onChange={(e) => applyPreset(e.target.value)}
              style={{ minWidth: 0, padding: "3px 6px", fontSize: 11, textTransform: "none" }}
            >
              {presetId === "" && <option value="">— custom —</option>}
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="reset-preset"
              title="Discard the restored/edited form and go back to the first preset"
              onClick={() => applyPreset(PRESETS[0].id)}
              className="btn"
              style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}
            >
              Reset
            </button>
          </span>
        </div>

        <div className="p-3">
          <p className="text-[11px] text-muted" data-testid="preset-note">
            {PRESETS.find((p) => p.id === presetId)?.note ??
              "Edited by hand. Pick a preset above to start over from a known spot."}
          </p>

          <div className="mt-3 grid gap-3">
            <Field label="board" hint="3–5 cards. Presets ship a turn card: the same ranges on a bare flop build a tree in the gigabytes.">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={form.board}
                  onChange={(e) => edit((f) => ({ ...f, board: e.target.value }))}
                />
                <button
                  type="button"
                  data-testid="random-flop"
                  onClick={() => edit((f) => ({ ...f, board: randomFlop() }))}
                  className="btn shrink-0"
                  style={{ padding: "4px 8px", fontSize: 11 }}
                >
                  random flop
                </button>
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="effective stack (bb)">
                <input
                  type="text"
                  value={form.effective_stack}
                  onChange={(e) => edit((f) => ({ ...f, effective_stack: e.target.value }))}
                />
              </Field>
              <Field label="starting pot (bb)">
                <input
                  type="text"
                  value={form.starting_pot}
                  onChange={(e) => edit((f) => ({ ...f, starting_pot: e.target.value }))}
                />
              </Field>
            </div>
          </div>

          <div className="mt-4">
            <span className="label">bet / raise sizings</span>
            <p className="mt-1 text-[11px] text-muted">
              percent of pot, comma separated. Add <span className="num text-muted">+</span> to also
              offer all-in. Blank = action not built.
            </p>
            <div className="mt-2 grid gap-2">
              {SEATS.map((seat) => (
                <div key={seat} style={BOX}>
                  <div className="label mb-1.5">{seat.toUpperCase()}</div>
                  <div className="grid grid-cols-[46px_1fr_1fr] items-center gap-1.5">
                    <span />
                    <span className="label">bet</span>
                    <span className="label">raise</span>
                    {STREETS.map((street) => (
                      <Row key={street} street={street} seat={seat} form={form} edit={edit} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <span className="label">table context</span>
            <p className="mt-1 text-[11px] text-muted">
              display only: positions and the player profile each range models. The engine solves
              the ranges; this labels where they came from.
            </p>
            <div className="mt-2 grid gap-2">
              {SEATS.map((seat) => {
                const prof = (form.context ?? EMPTY_CONTEXT)[seat];
                const setProf = (patch: Partial<SeatProfile>) =>
                  setForm((f) => {
                    const ctx = structuredClone(f.context ?? EMPTY_CONTEXT);
                    ctx[seat] = { ...ctx[seat], ...patch };
                    return { ...f, context: ctx };
                  });
                return (
                  <div key={seat} style={BOX}>
                    <div className="label mb-1.5">{seat.toUpperCase()}</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <label className="grid gap-0.5">
                        <span className="label">position</span>
                        <input
                          type="text"
                          data-testid={`ctx-${seat}-pos`}
                          value={prof.pos}
                          placeholder={seat.toUpperCase()}
                          onChange={(e) => setProf({ pos: e.target.value })}
                        />
                      </label>
                      <label className="grid gap-0.5">
                        <span className="label">VPIP %</span>
                        <input
                          type="text"
                          data-testid={`ctx-${seat}-vpip`}
                          value={prof.vpip}
                          placeholder="—"
                          onChange={(e) => setProf({ vpip: e.target.value })}
                        />
                      </label>
                      <label className="grid gap-0.5">
                        <span className="label">PFR %</span>
                        <input
                          type="text"
                          data-testid={`ctx-${seat}-pfr`}
                          value={prof.pfr}
                          placeholder="—"
                          onChange={(e) => setProf({ pfr: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <label className="mt-2 grid gap-0.5">
              <span className="label">preflop action</span>
              <input
                type="text"
                data-testid="ctx-preflop"
                value={(form.context ?? EMPTY_CONTEXT).preflop}
                placeholder="e.g. BTN opens 2.5bb, BB calls"
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    context: { ...structuredClone(f.context ?? EMPTY_CONTEXT), preflop: e.target.value },
                  }))
                }
              />
            </label>
          </div>
        </div>
      </section>

      <section className="col-ranges">
        <div className="bar">ranges &amp; tree</div>
        <div className="p-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <RangeEditor
              seat="oop"
              value={form.oop_range}
              onChange={(range) => edit((f) => ({ ...f, oop_range: range }))}
            />
            <RangeEditor
              seat="ip"
              value={form.ip_range}
              onChange={(range) => edit((f) => ({ ...f, ip_range: range }))}
            />
          </div>

          <div className="mt-4">
            <span className="label">solver budget</span>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <Field label="max iterations">
                <input
                  type="text"
                  value={form.max_iterations}
                  onChange={(e) => edit((f) => ({ ...f, max_iterations: e.target.value }))}
                />
              </Field>
              <Field label="target expl. (% pot)">
                <input
                  type="text"
                  value={form.target_pct}
                  onChange={(e) => edit((f) => ({ ...f, target_pct: e.target.value }))}
                />
              </Field>
              <Field label="report every N iters" hint="each report = 2 best-response walks">
                <input
                  type="text"
                  value={form.report_every}
                  onChange={(e) => edit((f) => ({ ...f, report_every: e.target.value }))}
                />
              </Field>
            </div>
          </div>
        </div>
      </section>

      <section className="col-run flex flex-col">
        <div className="bar shrink-0">preflight &amp; run</div>

        <div className="shrink-0 p-3">
          <button
            data-testid="solve-run"
            disabled={busy !== ""}
            onClick={() => run(false)}
            className="btn btn-primary w-full"
            style={{ height: 48, fontSize: 14 }}
          >
            {busy === "solving" ? "Solving…" : busy === "preflight" ? "Preflight…" : "Solve this spot →"}
          </button>
          <button
            disabled={busy !== ""}
            onClick={justPreflight}
            className="btn mt-2 w-full"
            style={{ height: 40 }}
          >
            Preflight only
          </button>
          <p className="mt-2 text-[11px] text-muted">
            Single-threaded in the browser. The CLI uses every core.
          </p>
        </div>

        {error && (
          <div
            data-testid="solve-error"
            role="alert"
            className="shrink-0"
            style={{
              background: "var(--color-err-bg)",
              borderTop: "var(--rule) solid var(--color-err)",
              color: "var(--color-text)",
              padding: "8px 10px",
            }}
          >
            <Chip>solve failed</Chip>
            <p className="num mt-1.5" style={{ fontSize: 12 }}>
              {error}
            </p>
          </div>
        )}

        <LocksPanel locks={locks} spot={spotKey(form)} onRemove={onRemoveLock} onClear={onClearLocks} />
        <StatsPanel stats={stats} gate={gate} onConfirm={() => run(true)} />
        <ProgressPanel reports={reports} busy={busy === "solving"} wall={wall} />
      </section>
    </div>
  );
}

/** Black slab naming the failure, printed above the message it belongs to. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        background: "var(--color-ink)",
        color: "var(--color-text-inv)",
        padding: "3px 7px",
        font: "800 10px/1.2 var(--font-sans)",
        letterSpacing: ".12em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

/** Sub-panel head inside a column: paper-2 strip, ink rule above and below. */
function Head({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="rule-t flex items-center gap-2"
      style={{
        background: "var(--color-paper-2)",
        padding: "6px 10px",
        borderBottom: "var(--rule-thin) solid var(--color-ink)",
      }}
    >
      <span className="label">{title}</span>
      {meta && (
        <span className="num" style={{ fontSize: 11, color: "var(--color-muted)" }}>
          {meta}
        </span>
      )}
      {children && <span style={{ marginLeft: "auto" }}>{children}</span>}
    </div>
  );
}

function Row({
  seat,
  street,
  form,
  edit,
}: {
  seat: "oop" | "ip";
  street: "flop" | "turn" | "river";
  form: SolveForm;
  edit: (fn: (f: SolveForm) => SolveForm) => void;
}) {
  const cell = form.sizings[seat][street];
  return (
    <>
      <span className="text-[11px] text-muted">{street}</span>
      <input
        type="text"
        aria-label={`${seat} ${street} bet sizings`}
        value={cell.bet}
        placeholder="—"
        onChange={(e) =>
          edit((f) => {
            f.sizings[seat][street].bet = e.target.value;
            return f;
          })
        }
      />
      <input
        type="text"
        aria-label={`${seat} ${street} raise sizings`}
        value={cell.raise}
        placeholder="—"
        onChange={(e) =>
          edit((f) => {
            f.sizings[seat][street].raise = e.target.value;
            return f;
          })
        }
      />
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function LocksPanel({
  locks,
  spot,
  onRemove,
  onClear,
}: {
  locks: NodeLock[];
  /** `spotKey` of the form as it stands; a lock from another spot can't be solved with. */
  spot: string;
  onRemove: (line: string) => void;
  onClear: () => void;
}) {
  const stale = locks.filter((l) => l.spot !== spot).length;
  return (
    <div className="shrink-0" data-testid="locks">
      <Head title="node locks" meta={`${locks.length} pending · ${stale} stale`}>
        {locks.length > 0 && (
          <button onClick={onClear} className="btn" style={{ padding: "3px 7px", fontSize: 10 }}>
            clear all
          </button>
        )}
      </Head>
      {locks.length === 0 ? (
        <p className="p-3 text-[11px] text-muted">
          None. Walk to a decision node in the Inspector and hit{" "}
          <span className="num text-muted">lock node</span> to freeze its strategy here; the
          next solve finds the equilibrium of the rest of the tree <em>given</em> that play, and its
          exploitability is measured against it.
        </p>
      ) : (
        <>
          <p className="p-3 text-[11px] text-muted">
            A lock names its node by the line walked from the root, so it only means anything
            against the tree it was read from. Change the board, ranges, stack or pot and the lock
            below is marked <span style={{ color: "var(--color-err)" }}>stale</span> and the solve
            refuses to run until it is removed. The same line on another board would resolve
            silently and freeze the wrong strategy.
          </p>
          <ul>
            {locks.map((l) => (
              <li
                key={l.line}
                className="flex items-center gap-2"
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderTop: "1px solid var(--color-line-soft)",
                  background: l.spot === spot ? undefined : "var(--color-err-bg)",
                }}
              >
                <span className="label shrink-0" style={{ color: "var(--color-text)" }}>
                  {l.player === 0 ? "OOP" : "IP"}
                </span>
                {l.spot !== spot && (
                  <span
                    className="label shrink-0"
                    style={{ color: "var(--color-err)" }}
                    title="Captured on a different board/ranges/stack/pot than the form above"
                  >
                    stale
                  </span>
                )}
                <span
                  className="num min-w-0 flex-1 truncate text-muted"
                  style={{ fontSize: 11 }}
                  title={l.line || "root"}
                >
                  {l.label}
                </span>
                <span className="num shrink-0 text-dim" style={{ fontSize: 10 }}>
                  {l.strategy.length} vals
                </span>
                <button
                  aria-label={`remove lock on ${l.label}`}
                  onClick={() => onRemove(l.line)}
                  className="btn btn-danger shrink-0"
                  style={{ padding: "3px 6px", fontSize: 10 }}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StatsPanel({
  stats,
  gate,
  onConfirm,
}: {
  stats: TreeStats | null;
  gate: Gate;
  onConfirm: () => void;
}) {
  return (
    <div className="shrink-0" data-testid="preflight">
      <Head title="preflight — tree_stats" />
      {!stats ? (
        <p className="p-3 text-[11px] text-muted">
          Builds the tree and combo tables without allocating the solver arrays, so you see the
          memory bill before paying it.
        </p>
      ) : (
        <>
          <div>
            <Stat i={0} k="nodes" v={stats.nodes.total.toLocaleString()} />
            <Stat i={1} k="decision" v={stats.nodes.decision.toLocaleString()} />
            <Stat i={2} k="boards" v={stats.boards.toLocaleString()} />
            <Stat i={3} k="root combos" v={`${stats.root_combos[0]} / ${stats.root_combos[1]}`} />
            <Stat i={4} k="locks resolved" v={stats.locks.toLocaleString()} />
            <Stat i={5} k="strategy entries" v={stats.strategy_entries.toLocaleString()} />
            <Stat i={6} k="chance maps" v={fmtBytes(stats.chance_map_bytes)} />
            <Stat i={7} k="solver storage" v={fmtBytes(stats.solver_storage_bytes)} />
          </div>
          <div
            style={{ padding: "8px 10px", borderTop: "var(--rule-thin) solid var(--color-ink)" }}
          >
            <div className="label">total resident</div>
            <div className="fig fig-2 mt-1">{fmtBytes(stats.total_bytes)}</div>
          </div>
        </>
      )}

      {gate === "warn" && (
        <div
          style={{
            background: "var(--color-accent)",
            color: "var(--color-ink)",
            borderTop: "var(--rule) solid var(--color-ink)",
            padding: "8px 10px",
          }}
        >
          <p style={{ font: "800 11px/1.35 var(--font-sans)", textTransform: "uppercase" }}>
            This solve wants {fmtBytes(stats?.total_bytes ?? 0)} resident, over the 300 MB comfort
            line for a browser tab. It may be slow or get killed.
          </p>
          <button onClick={onConfirm} className="btn mt-2 w-full">
            Solve anyway
          </button>
        </div>
      )}
      {gate === "hard" && (
        <div
          role="alert"
          style={{
            background: "var(--color-err-bg)",
            borderTop: "var(--rule) solid var(--color-err)",
            color: "var(--color-text)",
            padding: "8px 10px",
          }}
        >
          <Chip>too big for a tab</Chip>
          <p className="mt-1.5 text-[12px]">
            <strong>{fmtBytes(stats?.total_bytes ?? 0)}</strong> is past 1 GB. wasm aborts the module
            on a failed allocation: the tab will most likely die and take the solve with it. Run
            this one on the CLI.
          </p>
          <button onClick={onConfirm} className="btn btn-danger mt-2 w-full">
            I understand the risk, solve anyway
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, i }: { k: string; v: string; i: number }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3"
      style={{
        padding: "4px 10px",
        background: i % 2 ? "var(--color-paper-2)" : undefined,
      }}
    >
      <span className="label">{k}</span>
      <span className="num" style={{ fontSize: 12 }}>
        {v}
      </span>
    </div>
  );
}

function ProgressPanel({
  reports,
  busy,
  wall,
}: {
  reports: Report[];
  busy: boolean;
  wall: number | null;
}) {
  const last = reports[reports.length - 1];
  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 260 }} data-testid="progress">
      <Head
        title="convergence"
        meta={`${reports.length} report${reports.length === 1 ? "" : "s"}${
          wall != null ? ` · ${wall.toFixed(3)} s` : ""
        }`}
      />

      {reports.length === 0 ? (
        <p className="p-3 text-[11px] text-muted">
          {busy ? "solving…" : "Exploitability is measured with two full best-response walks per report."}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {last && (
            <div className="mb-2">
              <span className="label">exploitability</span>
              <div className="fig fig-1 mt-1">{last.pct.toFixed(4)}%</div>
              <div className="num mt-1 text-muted" style={{ fontSize: 11 }}>
                {last.chips.toFixed(6)} bb at iteration {last.iter}
              </div>
            </div>
          )}
          <Curve reports={reports} />
          <div className="mt-2 grid grid-cols-3 gap-x-2 border-b border-line-soft pb-1">
            <span className="label">iter</span>
            <span className="label text-right">bb</span>
            <span className="label text-right">% of pot</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {[...reports].reverse().map((r, i) => (
              <div
                key={r.iter}
                className="grid grid-cols-3 gap-x-2 py-0.5"
                style={{ background: i % 2 ? "var(--color-paper-2)" : undefined }}
              >
                <span className={`num ${i === 0 ? "text-text" : "text-muted"}`}>{r.iter}</span>
                <span className="num text-right text-muted">{r.chips.toFixed(6)}</span>
                <span className={`num text-right ${i === 0 ? "text-text" : "text-muted"}`}>
                  {r.pct.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Exploitability falls by orders of magnitude, so the y axis is log10(% of pot). */
function Curve({ reports }: { reports: Report[] }) {
  const W = 320;
  const H = 74;
  const ys = reports.map((r) => Math.log10(Math.max(r.pct, 1e-6)));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const pts = reports
    .map((r, i) => {
      const x = reports.length === 1 ? W / 2 : (i / (reports.length - 1)) * (W - 6) + 3;
      const y = H - 6 - ((ys[i] - lo) / span) * (H - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ background: "var(--color-paper-2)", border: "var(--rule-thin) solid var(--color-ink)" }}
      role="img"
      aria-label="exploitability curve"
    >
      <polyline points={pts} fill="none" stroke="var(--color-ink)" strokeWidth="1.5" />
      {reports.map((r, i) => {
        const x = reports.length === 1 ? W / 2 : (i / (reports.length - 1)) * (W - 6) + 3;
        const y = H - 6 - ((ys[i] - lo) / span) * (H - 12);
        return <circle key={r.iter} cx={x} cy={y} r="1.8" fill="var(--color-ink)" />;
      })}
      <text x="4" y="10" fill="var(--color-dim)" fontSize="8">
        {(10 ** hi).toFixed(4)}%
      </text>
      <text x="4" y={H - 2} fill="var(--color-dim)" fontSize="8">
        {(10 ** lo).toFixed(4)}%
      </text>
    </svg>
  );
}
