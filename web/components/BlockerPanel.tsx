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

const TOP_N = 8;
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
      <div className="panel flex items-center justify-center px-4 py-6 text-center text-dim">
        No {oppPlayer} decision is reachable from here to score blockers against.
      </div>
    );
  }

  const numActions = oppActions.length;
  const idx = Math.min(actionIdx, numActions - 1);
  const ranked = combos
    .map((c) => ({ combo: c, score: blockerScores(oppCombos, oppStrategy, numActions, c.cards) }))
    .sort((a, b) => b.score.delta[idx] - a.score.delta[idx])
    .slice(0, TOP_N);

  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="border-b border-line px-3 py-2">
        <span className="font-semibold">Blockers</span>
        <span className="ml-2 font-normal text-dim">
          vs. {oppPlayer}&apos;s next decision
        </span>
      </div>

      {cell ? (
        <div className="border-b border-line px-3 py-2">
          <div className="label mb-1">
            {cell.label} — shift in {oppPlayer}&apos;s frequencies
          </div>
          {cell.slots.map((slot) => {
            const combo = combos[slot];
            const score = blockerScores(oppCombos, oppStrategy, numActions, combo.cards);
            return (
              <div key={slot} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-0.5">
                <ComboCards cards={combo.cards} className="text-[13px]" />
                {oppActions.map((a, i) => (
                  <span key={i} className="num text-[11px]" style={{ color: oppColors[i] }} title={a.text}>
                    {a.label} {pct(score.delta[i])}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="border-b border-line px-3 py-2 text-dim">
          Click a cell in the range grid to see how it shifts {oppPlayer}&apos;s frequencies.
        </p>
      )}

      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="label">rank by</span>
        <div className="flex gap-px overflow-hidden rounded border border-line text-[11px]">
          {oppActions.map((a, i) => (
            <button
              key={i}
              onClick={() => setActionIdx(i)}
              className={`px-2 py-0.5 ${
                idx === i ? "bg-accent font-semibold text-ink" : "bg-raised text-muted hover:text-text"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="label mb-1">best {oppActions[idx].label} blockers</div>
        {ranked.map(({ combo, score }) => (
          <div key={combo.index} className="flex items-center justify-between py-0.5">
            <ComboCards cards={combo.cards} className="text-[13px]" />
            <span className="num text-[11px]" style={{ color: oppColors[idx] }}>
              {pct(score.delta[idx])}
            </span>
          </div>
        ))}
      </div>

      <p className="border-t border-line px-3 py-2 text-[11px] text-dim">
        Delta is {oppPlayer}&apos;s reach-weighted action frequency once combos that share a
        card with the hero hand are excluded, minus the frequency over their whole range —
        how much holding those two cards moves that action.
      </p>
    </div>
  );
}
