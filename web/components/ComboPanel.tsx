"use client";

import { ComboCards } from "@/components/Card";
import { Cell, cellOf, comboFreqs, comboRegret } from "@/lib/grid";
import type { Combo, NodeAction } from "@/lib/types";

interface Props {
  cell: Cell | null;
  combos: Combo[];
  strategy: Float32Array;
  evs: Float32Array;
  /** Per-action combo_evs(), one Float32Array per action, same slot order as `combos`. */
  actionEvs: Float32Array[];
  actions: NodeAction[];
  colors: string[];
  /** Range-wide frequency per action (view.freqs), for the no-selection ladder. */
  freqs: number[];
  player: string;
  /** The solution's `meta().payoff_unit`. Under `"cste"` these EVs are tournament
   *  equity, not big blinds, and are NOT zero-sum — the footnote below says which. */
  unit?: "chips" | "cste";
  /** Jump the grid selection to a cell — wired from the top-regret rows. */
  onPickCell: (c: { row: number; col: number }) => void;
}

export default function ComboPanel({
  cell,
  combos,
  strategy,
  evs,
  actionEvs,
  actions,
  colors,
  freqs,
  player,
  unit,
  onPickCell,
}: Props) {
  const n = combos.length;

  if (!cell) {
    return (
      <NodeOverview
        combos={combos}
        strategy={strategy}
        actionEvs={actionEvs}
        actions={actions}
        colors={colors}
        freqs={freqs}
        onPickCell={onPickCell}
      />
    );
  }

  const rows = cell.slots.map((slot) => ({
    slot,
    combo: combos[slot],
    freqs: comboFreqs(strategy, actions.length, n, slot),
    ev: evs[slot],
  }));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <h2 className="bar bar-strategy">
        <span style={{ font: "900 22px/1 var(--font-sans)", letterSpacing: "-.03em", textTransform: "none" }}>
          {cell.label}
        </span>
        <span className="meta">
          {rows.length} combo{rows.length === 1 ? "" : "s"} · {player} · weight {cell.weight.toFixed(3)}
        </span>
      </h2>

      {cell.noReach && (
        <p
          className="bg-accent px-2.5 py-1.5 uppercase text-[#101010]"
          style={{ font: "800 11px/1.3 var(--font-sans)", letterSpacing: ".04em" }}
        >
          Zero reach · frequencies below are the stored strategy, unweighted
        </p>
      )}

      <div
        className="combo-rows border-b-2 border-ink bg-paper-2 px-2.5 py-1.5"
        style={{ "--nact": actions.length } as React.CSSProperties}
      >
        <span className="label">hand</span>
        <span className="label text-right">weight</span>
        <span className="label">strategy</span>
        {actions.map((a, i) => (
          <span key={i} className="label flex items-center justify-end gap-1 truncate" title={a.text}>
            <span className="h-[5px] w-2.5 shrink-0" style={{ background: colors[i] }} />
            {a.label}
          </span>
        ))}
        <span className="label text-right">EV</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(({ slot, combo, freqs: f, ev }, ri) => (
          <div
            key={slot}
            className={`combo-rows h-[26px] px-2.5 hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] ${
              ri % 2 === 1 ? "bg-paper-2" : ""
            }`}
            style={{ "--nact": actions.length, borderBottom: "1px solid rgba(16,16,16,.14)" } as React.CSSProperties}
          >
            <ComboCards cards={combo.cards} className="text-[13px]" />
            <span className="num text-right text-muted">{combo.weight.toFixed(3)}</span>
            <span
              className="flex h-[18px] overflow-hidden bg-paper-2"
              style={{ outline: "1px solid var(--color-ink)", outlineOffset: "-1px" }}
            >
              {f.map((v, a) => (
                <span
                  key={a}
                  style={{ width: `${v * 100}%`, background: colors[a] }}
                  title={`${actions[a].text}: ${(v * 100).toFixed(1)}%`}
                />
              ))}
            </span>
            {/* Neutral ink, not the action colour: the light ramp ends fail AA as
                11px text on paper — the head-row swatch carries the colour coding. */}
            {actions.map((a, i) => {
              const v = actionEvs[i]?.[slot] ?? NaN;
              return (
                <span
                  key={i}
                  className={`num text-right text-[11px] ${Number.isNaN(v) ? "text-dim" : "text-muted"}`}
                  title={`${a.text} EV: ${Number.isNaN(v) ? "no defined EV" : v.toFixed(3)}`}
                >
                  {Number.isNaN(v) ? "—" : v.toFixed(2)}
                </span>
              );
            })}
            <span
              className={`num text-right ${Number.isNaN(ev) ? "text-dim" : ev >= 0 ? "text-ok" : "text-err"}`}
              title={
                Number.isNaN(ev)
                  ? "No defined EV: the opponent's range cannot reach this node holding anything this hand does not block."
                  : undefined
              }
            >
              {Number.isNaN(ev) ? "—" : ev.toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <div className="border-t-2 border-ink bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
        {unit === "cste"
          ? "EV is tournament equity in CSTE chips, measured against the start of the solve, both players on the solved average strategy. It is not zero-sum: the pair leaks equity to the rest of the table when the hand pushes their stacks apart, and draws equity back from it when the hand pulls them together."
          : "EV is zero-sum net big blinds from the start of the solve, both players on the solved average strategy."}{" "}
        “—” means the EV is undefined here, not zero.
      </div>
    </div>
  );
}

/**
 * No cell selected: aggregate the whole node instead of asking for a click — the
 * action EV ladder, then the 20 combos leaving the most chips on the table.
 */
function NodeOverview({
  combos,
  strategy,
  actionEvs,
  actions,
  colors,
  freqs,
  onPickCell,
}: {
  combos: Combo[];
  strategy: Float32Array;
  actionEvs: Float32Array[];
  actions: NodeAction[];
  colors: string[];
  freqs: number[];
  onPickCell: (c: { row: number; col: number }) => void;
}) {
  const n = combos.length;

  // Reach-weighted mean EV per action, NaN slots skipped.
  const ladder = actions
    .map((a, i) => {
      let sum = 0;
      let w = 0;
      for (let s = 0; s < n; s++) {
        const v = actionEvs[i]?.[s] ?? NaN;
        if (Number.isNaN(v)) continue;
        sum += combos[s].weight * v;
        w += combos[s].weight;
      }
      return { action: a, i, freq: freqs[i] ?? 0, mean: w > 0 ? sum / w : NaN };
    })
    .sort((a, b) => (Number.isNaN(b.mean) ? -Infinity : b.mean) - (Number.isNaN(a.mean) ? -Infinity : a.mean));

  const regrets = combos
    .map((c, s) => ({ combo: c, slot: s, regret: comboRegret(actionEvs, strategy, actions.length, n, s) }))
    .filter((r) => Number.isFinite(r.regret));
  regrets.sort((a, b) => b.regret - a.regret);
  const top = regrets.slice(0, 20);
  const undefinedCount = n - regrets.length;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <h2 className="bar">
        Node overview
        <span className="meta">
          {n} combos · no cell selected · click any cell to drill in
        </span>
      </h2>

      <div className="label border-b-2 border-ink bg-paper-2 px-2.5 py-1.5">Action EV ladder</div>
      <div>
        {ladder.map(({ action, i, freq, mean }, ri) => (
          <div
            key={i}
            className={`flex h-[30px] items-center gap-2.5 px-2.5 ${ri % 2 === 1 ? "bg-paper-2" : ""}`}
            style={{ borderBottom: "1px solid rgba(16,16,16,.14)" }}
          >
            <span className="h-2.5 w-2.5 shrink-0" style={{ background: colors[i] }} />
            <span className="num">{action.text}</span>
            <span className="num text-dim">{(freq * 100).toFixed(1)}%</span>
            <span className="fig fig-3 ml-auto">{Number.isNaN(mean) ? "—" : mean.toFixed(3)}</span>
          </div>
        ))}
      </div>

      <div className="label border-b-2 border-t-2 border-ink bg-paper-2 px-2.5 py-1.5">
        Top {top.length} by regret
        {undefinedCount > 0 ? ` · ${undefinedCount} combos have no defined regret` : ` · ${regrets.length} combos scored`}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {top.map(({ combo, slot, regret }, ri) => (
          <button
            key={slot}
            onClick={() => onPickCell(cellOf(combo.cards))}
            className={`grid h-[26px] w-full grid-cols-[64px_52px_minmax(0,1fr)_74px] items-center gap-x-2 px-2.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] ${
              ri % 2 === 1 ? "bg-paper-2" : ""
            }`}
            style={{ borderBottom: "1px solid rgba(16,16,16,.14)" }}
            title={`Select ${combo.cards.slice(0, 2)} ${combo.cards.slice(2, 4)} in the grid`}
          >
            <ComboCards cards={combo.cards} className="text-[13px]" />
            <span className="num text-right text-muted">{combo.weight.toFixed(3)}</span>
            <span
              className="flex h-[18px] overflow-hidden bg-paper-2"
              style={{ outline: "1px solid var(--color-ink)", outlineOffset: "-1px" }}
            >
              {comboFreqs(strategy, actions.length, n, slot).map((v, a) => (
                <span key={a} style={{ width: `${v * 100}%`, background: colors[a] }} />
              ))}
            </span>
            <span className="fig fig-3 text-right text-err">{regret.toFixed(3)}</span>
          </button>
        ))}
      </div>

      <div className="border-t-2 border-ink bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
        Regret is the big blinds a combo leaves on the table by mixing instead of always taking
        its best action. Click a row to open that hand class in the grid.
      </div>
    </div>
  );
}
