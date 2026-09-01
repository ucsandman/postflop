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
}

/**
 * The line rail: breadcrumb on the left half, this node's actions as full-bleed
 * frequency-inked blocks on the right. Chance and terminal nodes render their own
 * hero layouts in the inspector, so here they only get a short label.
 */
export default function TreeNav({ node, path, freqs, colors, onStep, onJump }: Props) {
  return (
    <div className="rule-b flex flex-wrap bg-panel">
      {/* Breadcrumb */}
      <nav
        aria-label="Line walked from the root"
        className="flex min-w-0 flex-1 basis-[420px] flex-wrap items-center gap-1.5 px-3 py-2.5"
      >
        <span className="label mr-1">line</span>
        <button onClick={() => onJump(0)} className="chip" aria-current={path.length === 0}>
          root
        </button>
        {path.map((step, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-dim">›</span>
            <button onClick={() => onJump(i + 1)} className="chip" aria-current={i === path.length - 1}>
              {step.label}
            </button>
          </span>
        ))}
        {node.kind === "decision" && node.locked && (
          <span
            data-testid="locked-badge"
            title="This node's strategy was frozen by a locks entry; the rest of the tree was solved around it."
            className="ml-1 bg-accent px-1.5 py-1 uppercase text-[#101010]"
            style={{ font: "800 10px/1 var(--font-sans)", letterSpacing: ".06em" }}
          >
            locked
          </span>
        )}
        {node.kind === "decision" && node.actions && (
          <span className="label ml-auto pl-2">
            {PLAYER_NAMES[node.player ?? 0]} to act · {node.actions.length} action
            {node.actions.length === 1 ? "" : "s"}
          </span>
        )}
      </nav>

      {/* Available moves */}
      {node.kind === "decision" && node.actions && (
        <div className="flex min-w-0 flex-1 basis-[420px] flex-wrap rule-l max-[999px]:border-l-0 max-[999px]:rule-t">
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
              className="relative h-11 min-w-0 flex-1 basis-[180px] overflow-hidden bg-[#1c1c1a] hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-accent"
              style={{ borderLeft: i > 0 ? "var(--rule-thin) solid var(--color-ink)" : undefined }}
            >
              <span
                className="absolute inset-y-0 left-0"
                style={{ width: `${(freqs[i] ?? 0) * 100}%`, background: colors[i] }}
              />
              <span className="relative z-[1] flex h-full items-center gap-2 px-2.5">
                <span
                  className="uppercase text-text-inv [text-shadow:0_1px_2px_rgba(0,0,0,.85)]"
                  style={{ font: "800 12px/1 var(--font-sans)", letterSpacing: ".04em" }}
                >
                  {a.text}
                </span>
                {a.percent_of_pot != null && (
                  <span className="num text-[11px]" style={{ color: "rgba(244,241,232,.72)" }}>
                    {a.percent_of_pot.toFixed(0)}%
                  </span>
                )}
                <span
                  className="ml-auto text-text-inv [text-shadow:0_1px_2px_rgba(0,0,0,.85)]"
                  style={{ font: "900 20px/1 var(--font-sans)", letterSpacing: "-.03em", fontVariantNumeric: "tabular-nums" }}
                >
                  {((freqs[i] ?? 0) * 100).toFixed(1)}%
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {node.kind === "chance" && (
        <div className="flex min-w-0 flex-1 basis-[420px] items-center rule-l px-3 max-[999px]:border-l-0">
          <span className="label">
            chance node: pick the {node.board.length === 3 ? "turn" : "river"} card below
          </span>
        </div>
      )}

      {node.kind === "terminal" && node.terminal && (
        <div className="flex min-w-0 flex-1 basis-[420px] items-center gap-2.5 rule-l px-3 max-[999px]:border-l-0">
          <span className="label">terminal</span>
          <span className="num">
            {node.terminal.kind === "fold"
              ? `${PLAYER_NAMES[node.terminal.folder]} folds · pot ${node.terminal.pot.toFixed(2)} bb`
              : `showdown · pot ${node.terminal.pot.toFixed(2)} bb`}
          </span>
        </div>
      )}
    </div>
  );
}

export function RunoutSelector({
  node,
  onStep,
  hotness,
  size = "normal",
}: {
  node: NodeInfo;
  onStep: (s: PathStep) => void;
  hotness?: RunoutHotness | null;
  size?: "normal" | "large";
}) {
  const valid = new Map(node.valid_cards!.map((v) => [v.card, v.child]));
  const onBoard = new Set(node.board);
  const nextStreet = node.board.length === 3 ? "turn" : "river";
  const large = size === "large";
  const cellCls = large ? "h-[52px] w-[64px] text-[18px]" : "h-6 w-7 text-[11px]";

  return (
    <div className="inline-flex flex-col" style={{ background: "var(--color-ink)", padding: 2, gap: 2 }}>
      {hotness && hotness.maxDeviation > 0 && (
        <div className="label px-1 py-1" style={{ color: "var(--color-dim-inv)" }}>
          shaded by hero EV vs. the runout average
        </div>
      )}
      {SUITS.split("").map((suit) => (
        <div key={suit} className="flex" style={{ gap: 2 }}>
          <span
            className={`num on-ink flex w-[22px] items-center justify-center text-[13px] ${SUIT_CLASS[suit]}`}
            style={{ background: "var(--color-ink)" }}
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
                      ? `deal ${card}: hero EV ${ev.toFixed(3)}`
                      : `deal ${card}`
                }
                style={tint ? { background: tint, color: "var(--color-ink)" } : undefined}
                className={[
                  "num font-bold transition-colors",
                  cellCls,
                  child === undefined
                    ? dead
                      ? "cursor-not-allowed bg-[#1c1c1a] text-[#5a5852] line-through"
                      : "cursor-not-allowed bg-[#1c1c1a] text-[#3a3936]"
                    : tint
                      ? "cursor-pointer hover:!bg-accent hover:!text-[#101010]"
                      : `on-ink cursor-pointer bg-[#2a2a26] hover:!bg-accent hover:!text-[#101010] ${SUIT_CLASS[suit]}`,
                ].join(" ")}
              >
                {rank}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function BoardStrip({
  board,
  size = 15,
  variant = "glyph",
}: {
  board: string[];
  size?: number;
  variant?: "glyph" | "stock";
}) {
  return board.length ? (
    <Cards
      cards={board}
      variant={variant}
      size={variant === "stock" ? size : undefined}
      className={variant === "stock" ? "gap-1" : "font-semibold"}
    />
  ) : (
    <Card card="?s" className="opacity-30" />
  );
}
