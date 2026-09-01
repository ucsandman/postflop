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
    // Wider than the Inspector's shell on purpose: two 13x13 grids side by side need
    // the room, and `html { font-size: 13px }` makes Tailwind's rem widths ~20% narrower
    // than their names suggest.
    <div className="mx-auto grid max-w-[1400px] gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="panel p-4">
        <div className="mb-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <h2 className="text-[15px] font-semibold">Solve a spot in this browser</h2>
            <select
              value={presetId}
              data-testid="preset-select"
              aria-label="spot preset"
              onChange={(e) => applyPreset(e.target.value)}
              className="ml-auto max-w-full rounded border border-line bg-raised px-2 py-1 text-text"
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
              className="rounded border border-line bg-raised px-2 py-1 text-[11px] text-muted hover:border-accent-dim hover:text-text"
            >
              Reset
            </button>
          </div>
          <p className="mt-1 text-[11px] text-dim" data-testid="preset-note">
            {PRESETS.find((p) => p.id === presetId)?.note ??
              "Edited by hand. Pick a preset above to start over from a known spot."}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
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
                className="shrink-0 rounded border border-line bg-raised px-2 py-1 text-[11px] text-muted hover:border-accent-dim hover:text-text"
              >
                random flop
              </button>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="effective stack">
              <input
                type="text"
                value={form.effective_stack}
                onChange={(e) => edit((f) => ({ ...f, effective_stack: e.target.value }))}
              />
            </Field>
            <Field label="starting pot">
              <input
                type="text"
                value={form.starting_pot}
                onChange={(e) => edit((f) => ({ ...f, starting_pot: e.target.value }))}
              />
            </Field>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
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
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="label">table context</span>
            <span className="text-[11px] text-dim">
              display only — positions and the player profile each range models. The engine
              solves the ranges; this labels where they came from.
            </span>
          </div>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {SEATS.map((seat) => {
              const prof = (form.context ?? EMPTY_CONTEXT)[seat];
              const setProf = (patch: Partial<SeatProfile>) =>
                setForm((f) => {
                  const ctx = structuredClone(f.context ?? EMPTY_CONTEXT);
                  ctx[seat] = { ...ctx[seat], ...patch };
                  return { ...f, context: ctx };
                });
              return (
                <div key={seat} className="rounded border border-line-soft p-2">
                  <div className="label mb-1 text-accent-dim">{seat.toUpperCase()}</div>
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

        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="label">bet / raise sizings</span>
            <span className="text-[11px] text-dim">
              percent of pot, comma separated. Add <span className="num text-muted">+</span> to also
              offer all-in. Blank = action not built.
            </span>
          </div>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {SEATS.map((seat) => (
              <div key={seat} className="rounded border border-line-soft p-2">
                <div className="label mb-1 text-accent-dim">{seat.toUpperCase()}</div>
                <div className="grid grid-cols-[46px_1fr_1fr] items-center gap-1.5">
                  <span />
                  <span className="label">bet</span>
                  <span className="label">raise</span>
                  {STREETS.map((street) => (
                    <Row
                      key={street}
                      street={street}
                      seat={seat}
                      form={form}
                      edit={edit}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
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

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            data-testid="solve-run"
            disabled={busy !== ""}
            onClick={() => run(false)}
            className="rounded bg-accent px-3.5 py-1.5 font-semibold text-ink hover:bg-[#efbc60] disabled:opacity-40"
          >
            {busy === "solving" ? "Solving…" : busy === "preflight" ? "Preflight…" : "Solve"}
          </button>
          <button
            disabled={busy !== ""}
            onClick={justPreflight}
            className="rounded border border-line bg-raised px-3 py-1.5 hover:border-accent-dim disabled:opacity-40"
          >
            Preflight only
          </button>
          <span className="text-[11px] text-dim">
            Single-threaded in the browser. The CLI uses every core.
          </span>
        </div>

        {error && (
          <p
            data-testid="solve-error"
            className="mt-3 rounded border border-[#7a2b25] bg-[#1e0e0c] px-3 py-2 text-card-h"
          >
            {error}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <LocksPanel locks={locks} spot={spotKey(form)} onRemove={onRemoveLock} onClear={onClearLocks} />
        <StatsPanel stats={stats} gate={gate} onConfirm={() => run(true)} />
        <ProgressPanel reports={reports} busy={busy === "solving"} wall={wall} />
      </div>
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
      {hint && <span className="mt-0.5 block text-[10px] text-dim">{hint}</span>}
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
  return (
    <div className="panel p-3" data-testid="locks">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">node locks</span>
        {locks.length > 0 && (
          <button
            onClick={onClear}
            className="rounded border border-line bg-raised px-2 py-0.5 text-[11px] text-muted hover:border-accent-dim hover:text-text"
          >
            clear all
          </button>
        )}
      </div>
      {locks.length === 0 ? (
        <p className="text-dim">
          None. Walk to a decision node in the Inspector and hit{" "}
          <span className="num text-muted">🔒 lock this node</span> to freeze its strategy
          here; the next solve finds the equilibrium of the rest of the tree{" "}
          <em>given</em> that play, and its exploitability is measured against it.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-dim">
            A lock names its node by the line walked from the root, so it only means anything
            against the tree it was read from. Change the board, ranges, stack or pot and the
            lock below is marked <span className="text-card-h">stale</span> and the solve
            refuses to run until it is removed — the same line on another board would resolve
            silently and freeze the wrong strategy.
          </p>
          <ul className="flex flex-col gap-1">
          {locks.map((l) => (
            <li
              key={l.line}
              className={`flex items-center gap-2 rounded border bg-raised px-2 py-1 ${
                l.spot === spot ? "border-line-soft" : "border-[#7a2b25]"
              }`}
            >
              <span className="shrink-0 text-accent">{l.player === 0 ? "OOP" : "IP"}</span>
              {l.spot !== spot && (
                <span
                  className="shrink-0 text-[10px] text-card-h"
                  title="Captured on a different board/ranges/stack/pot than the form above"
                >
                  stale
                </span>
              )}
              <span className="num min-w-0 flex-1 truncate text-[11px] text-muted" title={l.line || "root"}>
                {l.label}
              </span>
              <span className="num shrink-0 text-[10px] text-dim">{l.strategy.length} vals</span>
              <button
                aria-label={`remove lock on ${l.label}`}
                onClick={() => onRemove(l.line)}
                className="shrink-0 rounded border border-line px-1.5 text-[11px] text-dim hover:border-[#7a2b25] hover:text-card-h"
              >
                ✕
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
    <div className="panel p-3" data-testid="preflight">
      <div className="label mb-2">preflight — tree_stats</div>
      {!stats ? (
        <p className="text-dim">
          Builds the tree and combo tables without allocating the solver arrays, so you see
          the memory bill before paying it.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Stat k="nodes" v={stats.nodes.total.toLocaleString()} />
          <Stat k="decision" v={stats.nodes.decision.toLocaleString()} />
          <Stat k="boards" v={stats.boards.toLocaleString()} />
          <Stat k="root combos" v={`${stats.root_combos[0]} / ${stats.root_combos[1]}`} />
          <Stat k="locks resolved" v={stats.locks.toLocaleString()} />
          <Stat k="strategy entries" v={stats.strategy_entries.toLocaleString()} />
          <Stat k="chance maps" v={fmtBytes(stats.chance_map_bytes)} />
          <Stat k="solver storage" v={fmtBytes(stats.solver_storage_bytes)} strong />
          <Stat k="total resident" v={fmtBytes(stats.total_bytes)} strong />
        </dl>
      )}

      {gate === "warn" && (
        <div className="mt-3 rounded border border-accent-dim bg-[#1c1608] p-2">
          <p className="text-accent">
            This solve wants {fmtBytes(stats?.total_bytes ?? 0)} resident, over the 300 MB
            comfort line for a browser tab. It may be slow or get killed.
          </p>
          <button
            onClick={onConfirm}
            className="mt-2 rounded bg-accent px-3 py-1 font-semibold text-ink"
          >
            Solve anyway
          </button>
        </div>
      )}
      {gate === "hard" && (
        <div className="mt-3 rounded border border-[#7a2b25] bg-[#1e0e0c] p-2">
          <p className="text-card-h">
            <strong>{fmtBytes(stats?.total_bytes ?? 0)}</strong> is past 1 GB. wasm aborts the
            module on a failed allocation — the tab will most likely die and take the solve with
            it. Run this one on the CLI.
          </p>
          <button
            onClick={onConfirm}
            className="mt-2 rounded border border-[#7a2b25] px-3 py-1 font-semibold text-card-h hover:bg-[#2a1210]"
          >
            I understand the risk — solve anyway
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <>
      <dt className="text-dim">{k}</dt>
      <dd className={`num text-right ${strong ? "font-semibold text-accent" : "text-text"}`}>{v}</dd>
    </>
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
    <div className="panel flex min-h-[220px] flex-col p-3" data-testid="progress">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">convergence</span>
        <span className="num text-dim">
          {reports.length} report{reports.length === 1 ? "" : "s"}
          {wall != null && ` · ${wall.toFixed(3)} s`}
        </span>
      </div>

      {reports.length === 0 ? (
        <p className="text-dim">
          {busy ? "solving…" : "Exploitability is measured with two full best-response walks per report."}
        </p>
      ) : (
        <>
          <Curve reports={reports} />
          <div className="mt-2 grid grid-cols-3 gap-x-2 border-b border-line-soft pb-1">
            <span className="label">iter</span>
            <span className="label text-right">chips</span>
            <span className="label text-right">% of pot</span>
          </div>
          <div className="max-h-40 flex-1 overflow-y-auto">
            {[...reports].reverse().map((r, i) => (
              <div key={r.iter} className="grid grid-cols-3 gap-x-2 py-0.5">
                <span className={`num ${i === 0 ? "text-accent" : "text-muted"}`}>{r.iter}</span>
                <span className="num text-right text-muted">{r.chips.toFixed(6)}</span>
                <span className={`num text-right ${i === 0 ? "text-accent" : "text-muted"}`}>
                  {r.pct.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
          {last && (
            <p className="mt-1 border-t border-line pt-1.5 text-[11px] text-dim">
              latest: <span className="num text-muted">{last.chips.toFixed(6)}</span> chips ={" "}
              <span className="num text-muted">{last.pct.toFixed(4)}%</span> of pot at iteration{" "}
              <span className="num text-muted">{last.iter}</span>
            </p>
          )}
        </>
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
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-[#0a0e15]" role="img" aria-label="exploitability curve">
      <polyline points={pts} fill="none" stroke="#e0aa4e" strokeWidth="1.5" />
      {reports.map((r, i) => {
        const x = reports.length === 1 ? W / 2 : (i / (reports.length - 1)) * (W - 6) + 3;
        const y = H - 6 - ((ys[i] - lo) / span) * (H - 12);
        return <circle key={r.iter} cx={x} cy={y} r="1.8" fill="#e0aa4e" />;
      })}
      <text x="4" y="10" fill="#5b6577" fontSize="8">
        {(10 ** hi).toFixed(4)}%
      </text>
      <text x="4" y={H - 2} fill="#5b6577" fontSize="8">
        {(10 ** lo).toFixed(4)}%
      </text>
    </svg>
  );
}
