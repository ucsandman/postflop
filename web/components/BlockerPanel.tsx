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
  oppPlayer,
}: Props) {
  const [actionIdx, setActionIdx] = useState(0);

  if (!oppStrategy || oppActions.length === 0) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <h2 className="bar bar-blockers">Blockers</h2>
        <div className="p-3">
          <div className="label mb-1.5">No {oppPlayer} decision reachable</div>
          <p className="text-[12px] text-muted">
            Every action from this node lands on a chance or terminal node, so there is no{" "}
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

  /** Longest bar in the ranked list, so the tracks read as one scale. */
  const maxRanked = Math.max(1e-9, ...ranked.map((r) => Math.abs(r.score.delta[idx])));

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
        <div className="rule-b px-2.5 py-2">
          <div className="label mb-1.5">
            {cell.label}: shift in {oppPlayer} frequencies
          </div>
          {selRows.map(({ slot, combo, score }) => (
            <div key={slot} className="rule-b py-1.5">
              <ComboCards cards={combo.cards} variant="stock" size={10} />
              <div className="mt-1 flex gap-1">
                {oppActions.map((a, i) => {
                  const d = score.delta[i];
                  const mag = Math.min(1, Math.abs(d) / maxAbsDelta);
                  return (
                    /* The figure sits beside the track, never on it: the bar diverges
                       from the centre line, so a centred number was always cut in half
                       by its own fill. */
                    <span key={i} className="flex flex-1 items-center gap-1.5" title={`${a.text}: ${pct(d)}`}>
                      <span className="relative h-[16px] min-w-0 flex-1 overflow-hidden bg-ink-2">
                        <span
                          className="absolute top-0 h-full"
                          style={{
                            left: d >= 0 ? "50%" : `${50 - mag * 50}%`,
                            width: `${mag * 50}%`,
                            /* The diamond plate, not the action ink: this bar is a
                               magnitude, not an action. */
                            background: "var(--color-plate-d)",
                          }}
                        />
                      </span>
                      <span
                        className="num w-11 shrink-0 text-right text-text"
                        style={{ fontSize: 10.5 }}
                      >
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

      <div className="flex items-center gap-2 rule-b px-2.5 py-2">
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
        {ranked.map(({ combo, score }) => (
          <div
            key={combo.index}
            className="grid h-[26px] grid-cols-[52px_minmax(0,1fr)_54px] items-center gap-2.5 px-1"
          >
            <ComboCards cards={combo.cards} className="text-[11px]" />
            <span className="block h-[9px] bg-ink-2">
              <span
                className="block h-[9px]"
                style={{
                  width: `${(maxRanked > 0 ? Math.min(1, Math.abs(score.delta[idx]) / maxRanked) : 0) * 100}%`,
                  background: "var(--color-card-d)",
                }}
              />
            </span>
            <span className="num text-right text-[11px] text-dim">{pct(score.delta[idx])}</span>
          </div>
        ))}
      </div>

      <p className="rule-t bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
        <span className="block max-w-[68ch]">
        Delta is {oppPlayer}&apos;s reach-weighted action frequency once combos that share a
        card with the hero hand are excluded, minus the frequency over their whole range:
        how much holding those two cards moves that action.
        </span>
      </p>
    </div>
  );
}
