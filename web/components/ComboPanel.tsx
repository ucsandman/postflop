"use client";

import { ComboCards } from "@/components/Card";
import { Cell, comboFreqs } from "@/lib/grid";
import type { Combo, NodeAction } from "@/lib/types";

interface Props {
  cell: Cell | null;
  combos: Combo[];
  strategy: Float32Array;
  evs: Float32Array;
  actions: NodeAction[];
  colors: string[];
  player: string;
}

export default function ComboPanel({ cell, combos, strategy, evs, actions, colors, player }: Props) {
  if (!cell) {
    return (
      <div className="panel flex h-full min-h-[180px] items-center justify-center px-4 text-center text-dim">
        Click a cell in the range grid to break it down combo by combo.
      </div>
    );
  }

  const n = combos.length;
  const rows = cell.slots.map((slot) => ({
    slot,
    combo: combos[slot],
    freqs: comboFreqs(strategy, actions.length, n, slot),
    ev: evs[slot],
  }));

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="num text-base font-semibold text-accent">{cell.label}</span>
          <span className="text-dim">
            {rows.length} combo{rows.length === 1 ? "" : "s"} · {player}
          </span>
        </div>
        <span className="num text-muted">weight {cell.weight.toFixed(3)}</span>
      </div>

      {cell.noReach && (
        <p className="border-b border-line bg-[#1c1608] px-3 py-1.5 text-[11px] text-accent">
          Zero reach: this cell is never here on the solved line. Frequencies below are the
          stored strategy, unweighted.
        </p>
      )}

      <div className="grid grid-cols-[64px_52px_1fr_66px] gap-x-2 border-b border-line-soft px-3 py-1">
        <span className="label">hand</span>
        <span className="label text-right">weight</span>
        <span className="label">strategy</span>
        <span className="label text-right">EV (chips)</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.map(({ slot, combo, freqs, ev }) => (
          <div
            key={slot}
            className="grid grid-cols-[64px_52px_1fr_66px] items-center gap-x-2 border-b border-line-soft/60 px-3 py-1 hover:bg-raised"
          >
            <ComboCards cards={combo.cards} className="text-[13px]" />
            <span className="num text-right text-muted">{combo.weight.toFixed(3)}</span>
            <span className="flex h-3.5 overflow-hidden rounded-sm bg-[#0a0e15]">
              {freqs.map((f, a) => (
                <span
                  key={a}
                  style={{ width: `${f * 100}%`, background: colors[a] }}
                  title={`${actions[a].text}: ${(f * 100).toFixed(1)}%`}
                />
              ))}
            </span>
            <span
              className={`num text-right ${
                Number.isNaN(ev) ? "text-dim" : ev >= 0 ? "text-card-c" : "text-card-h"
              }`}
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

      <div className="border-t border-line px-3 py-1.5 text-[11px] text-dim">
        EV is zero-sum net chips from the start of the solve, both players on the solved
        average strategy. “—” means the EV is undefined here, not zero.
      </div>
    </div>
  );
}
