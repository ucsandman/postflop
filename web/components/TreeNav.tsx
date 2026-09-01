"use client";

import Card, { Cards } from "@/components/Card";
import { actionToken } from "@/lib/config";
import { hotnessColor, RANKS, SUITS, SUIT_CLASS, SUIT_GLYPH, type RunoutHotness } from "@/lib/grid";
import type { NodeInfo, PathStep } from "@/lib/types";
import { PLAYER_NAMES } from "@/lib/types";

interface Props {
  node: NodeInfo;
  path: PathStep[];
  /** Range-wide frequency per action at this decision node; empty elsewhere. */
  freqs: number[];
  colors: string[];
  onStep: (step: PathStep) => void;
  onJump: (depth: number) => void;
  /** How each runout shifts hero EV, for the chance-node card grid. Absent elsewhere. */
  hotness?: RunoutHotness | null;
}

export default function TreeNav({ node, path, freqs, colors, onStep, onJump, hotness }: Props) {
  return (
    <div className="panel flex flex-col">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        <span className="label mr-1">line</span>
        <button
          onClick={() => onJump(0)}
          className="rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] hover:border-accent-dim"
        >
          root
        </button>
        {path.map((step, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-dim">›</span>
            <button
              onClick={() => onJump(i + 1)}
              className={`num rounded border px-1.5 py-0.5 text-[11px] hover:border-accent-dim ${
                i === path.length - 1
                  ? "border-accent-dim bg-[#1c1608] text-accent"
                  : "border-line bg-raised"
              }`}
            >
              {step.label}
            </button>
          </span>
        ))}
      </div>

      {/* Available moves */}
      <div className="px-3 py-2">
        {node.kind === "decision" && node.actions && (
          <>
            <div className="label mb-1.5 flex items-center gap-2">
              <span>
                {PLAYER_NAMES[node.player ?? 0]} to act — {node.actions.length} action
                {node.actions.length === 1 ? "" : "s"}
              </span>
              {node.locked && (
                <span
                  data-testid="locked-badge"
                  title="This node's strategy was frozen by a [[locks]] entry — the rest of the tree was solved around it."
                  className="rounded border border-accent-dim bg-[#1c1608] px-1.5 py-0.5 text-[10px] font-semibold tracking-normal text-accent"
                >
                  🔒 locked
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {node.actions.map((a, i) => (
                <button
                  key={i}
                  onClick={() =>
                    onStep({
                      from: node.id,
                      to: a.child,
                      kind: "action",
                      label: `${PLAYER_NAMES[node.player ?? 0]} ${a.text}`,
                      token: actionToken(a),
                    })
                  }
                  className="group relative overflow-hidden rounded border border-line bg-raised px-2.5 py-1.5 text-left hover:border-accent-dim"
                >
                  <span
                    className="absolute inset-y-0 left-0 opacity-25"
                    style={{ width: `${(freqs[i] ?? 0) * 100}%`, background: colors[i] }}
                  />
                  <span className="relative flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                      style={{ background: colors[i] }}
                    />
                    <span className="num">{a.text}</span>
                    {a.percent_of_pot != null && (
                      <span className="num text-dim">{a.percent_of_pot.toFixed(0)}%</span>
                    )}
                    <span className="num font-semibold text-accent">
                      {((freqs[i] ?? 0) * 100).toFixed(1)}%
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {node.kind === "chance" && node.valid_cards && (
          <RunoutSelector node={node} onStep={onStep} hotness={hotness} />
        )}

        {node.kind === "terminal" && node.terminal && (
          <div className="text-muted">
            <span className="label mr-2">terminal</span>
            {node.terminal.kind === "fold" ? (
              <span className="num">
                {PLAYER_NAMES[node.terminal.folder]} folds · pot {node.terminal.pot.toFixed(2)}
              </span>
            ) : (
              <span className="num">showdown · pot {node.terminal.pot.toFixed(2)}</span>
            )}
            <span className="ml-2 text-dim">
              — no strategy here; step back up the line to keep inspecting.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function RunoutSelector({
  node,
  onStep,
  hotness,
}: {
  node: NodeInfo;
  onStep: (s: PathStep) => void;
  hotness?: RunoutHotness | null;
}) {
  const valid = new Map(node.valid_cards!.map((v) => [v.card, v.child]));
  const onBoard = new Set(node.board);
  const nextStreet = node.board.length === 3 ? "turn" : "river";

  return (
    <>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="label">deal the {nextStreet}</span>
        <span className="num text-dim">
          {valid.size} of 52 available · {onBoard.size} on board
        </span>
        {hotness && hotness.maxDeviation > 0 && (
          <span className="text-[11px] text-dim">— shaded by hero EV vs. the runout average</span>
        )}
      </div>
      <div className="inline-flex flex-col gap-px rounded border border-line-soft bg-line-soft p-px">
        {SUITS.split("").map((suit) => (
          <div key={suit} className="flex gap-px">
            <span
              className={`num flex w-6 items-center justify-center bg-panel text-[12px] ${SUIT_CLASS[suit]}`}
            >
              {SUIT_GLYPH[suit]}
            </span>
            {RANKS.split("").map((rank) => {
              const card = rank + suit;
              const child = valid.get(card);
              const dead = onBoard.has(card);
              const deviation = child !== undefined ? hotness?.deviationByChild.get(child) : undefined;
              const tint =
                deviation !== undefined ? hotnessColor(deviation, hotness!.maxDeviation) : null;
              const ev = child !== undefined ? hotness?.evByChild.get(child) : undefined;
              return (
                <button
                  key={card}
                  disabled={child === undefined}
                  onClick={() =>
                    onStep({
                      from: node.id,
                      to: child!,
                      kind: "chance",
                      label: `${nextStreet} ${card}`,
                      token: card,
                    })
                  }
                  title={
                    dead
                      ? `${card} is already on the board`
                      : ev !== undefined && !Number.isNaN(ev)
                        ? `deal ${card} — hero EV ${ev.toFixed(3)}`
                        : `deal ${card}`
                  }
                  style={tint ? { background: tint } : undefined}
                  className={[
                    "num h-6 w-7 text-[11px] font-semibold transition-colors",
                    child === undefined
                      ? dead
                        ? "cursor-not-allowed bg-[#241214] text-[#6b3238] line-through"
                        : "cursor-not-allowed bg-[#0b0f16] text-[#2c3442]"
                      : `cursor-pointer hover:bg-accent hover:text-ink ${tint ? "" : "bg-raised"} ${SUIT_CLASS[suit]}`,
                  ].join(" ")}
                >
                  {rank}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

export function BoardStrip({ board }: { board: string[] }) {
  return board.length ? (
    <Cards cards={board} className="text-[15px] font-semibold" />
  ) : (
    <Card card="?s" className="opacity-30" />
  );
}
