"use client";

import { useState } from "react";
import { ComboCards } from "@/components/Card";
import { Cell, blockerScores } from "@/lib/grid";
import type { Combo, NodeAction } from "@/lib/types";

interface Props {
  cell: Cell | null;
  /** Hero's live combos at this node -- the ranked list is built from these. */
  combos: Combo[];
  /** Opponent's combos at their next decision node (same slots/order as `oppStrategy`). */
  oppCombos: Combo[];
  /** Opponent's strategy at their next decision node; null when none is reachable. */
  oppStrategy: Float32Array | null;
  oppActions: NodeAction[];
  oppColors: string[];
  oppPlayer: string;
}

const TOP_N = 12;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export default function BlockerPanel({
  cell,
  combos,
  oppCombos,
  oppStrategy,
  oppActions,
  oppColors,
  oppPlayer,
}: Props) {
  const [actionIdx, setActionIdx] = useState(0);

  if (!oppStrategy || oppActions.length === 0) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <h2 className="bar bar-blockers">Blockers</h2>
        <div className="p-3">
          <div className="label mb-1.5">No {oppPlayer} decision reachable</div>
          <p className="num text-[12px] text-muted">
            every action from this node lands on a chance or terminal node, so there is no{" "}
            {oppPlayer} strategy here to score removal against.
          </p>
        </div>
      </div>
    );
  }

  const numActions = oppActions.length;
  const idx = Math.min(actionIdx, numActions - 1);
  const ranked = combos
    .map((c) => ({ combo: c, score: blockerScores(oppCombos, oppStrategy, numActions, c.cards) }))
    .sort((a, b) => b.score.delta[idx] - a.score.delta[idx])
    .slice(0, TOP_N);

  const selRows = cell
    ? cell.slots.map((slot) => {
        const combo = combos[slot];
        return { slot, combo, score: blockerScores(oppCombos, oppStrategy, numActions, combo.cards) };
      })
    : [];
  const maxAbsDelta = Math.max(
    1e-9,
    ...selRows.flatMap((r) => r.score.delta.map((d) => Math.abs(d))),
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <h2 className="bar bar-blockers">
        Blockers
        <span className="meta">vs {oppPlayer} · next decision</span>
      </h2>

      {cell && (
        <div className="border-b-2 border-ink px-2.5 py-2">
          <div className="label mb-1.5">
            {cell.label}: shift in {oppPlayer} frequencies
          </div>
          {selRows.map(({ slot, combo, score }) => (
            <div key={slot} className="py-1" style={{ borderBottom: "1px solid rgba(16,16,16,.1)" }}>
              <ComboCards cards={combo.cards} className="text-[13px]" />
              <div className="mt-0.5 flex gap-1">
                {oppActions.map((a, i) => {
                  const d = score.delta[i];
                  const mag = Math.min(1, Math.abs(d) / maxAbsDelta);
                  return (
                    <span
                      key={i}
                      className="relative h-[14px] flex-1 overflow-hidden bg-paper-2"
                      title={`${a.text}: ${pct(d)}`}
                    >
                      <span
                        className="absolute top-0 h-full"
                        style={{
                          left: d >= 0 ? "50%" : `${50 - mag * 50}%`,
                          width: `${mag * 50}%`,
                          background: oppColors[i],
                        }}
                      />
                      <span className="num absolute inset-0 flex items-center justify-center text-[10px]">
                        {pct(d)}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 border-b-2 border-ink px-2.5 py-2">
        <span className="label">rank by</span>
        <span className="seg">
          {oppActions.map((a, i) => (
            <button key={i} aria-pressed={idx === i} onClick={() => setActionIdx(i)}>
              {a.label}
            </button>
          ))}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        <div className="label mb-1">
          best {oppActions[idx].label} blockers{cell ? "" : " · whole range"}
        </div>
        {ranked.map(({ combo, score }, ri) => (
          <div
            key={combo.index}
            className={`flex h-[24px] items-center justify-between px-1 ${ri % 2 === 1 ? "bg-paper-2" : ""}`}
          >
            <ComboCards cards={combo.cards} className="text-[13px]" />
            <span className="num text-[11px] font-bold">{pct(score.delta[idx])}</span>
          </div>
        ))}
      </div>

      <p className="border-t-2 border-ink bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
        Delta is {oppPlayer}&apos;s reach-weighted action frequency once combos that share a
        card with the hero hand are excluded, minus the frequency over their whole range:
        how much holding those two cards moves that action.
      </p>
    </div>
  );
}
