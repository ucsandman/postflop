"use client";

import Card, { Cards } from "@/components/Card";
import { actionToken } from "@/lib/config";
import { hatched, hotnessColor, RANKS, SUITS, SUIT_CLASS, SUIT_GLYPH, type RunoutHotness } from "@/lib/grid";
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
        data-tour="line"
        className="flex min-w-0 flex-1 basis-[420px] flex-wrap items-center gap-1.5 px-3 py-2.5"
      >
        <span className="label mr-1">line</span>
        <button
          onClick={() => onJump(0)}
          className="chip flex items-center gap-2"
          aria-current={path.length === 0}
        >
          <StepSquare step={null} current={path.length === 0} />
          root
        </button>
        {path.map((step, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-dim">/</span>
            <button
              onClick={() => onJump(i + 1)}
              className="chip flex items-center gap-2"
              aria-current={i === path.length - 1}
            >
              <StepSquare step={step} current={i === path.length - 1} />
              {step.label}
            </button>
          </span>
        ))}
        {node.kind === "decision" && node.locked && (
          <span
            data-testid="locked-badge"
            title="This node's strategy was frozen by a locks entry; the rest of the tree was solved around it."
            className="ml-1 bg-accent px-1.5 py-1 uppercase text-accent-ink"
            style={{ font: "600 10px/1 var(--font-condensed)", letterSpacing: ".15em" }}
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
        <div
          data-tour="actions"
          className="flex min-w-0 flex-1 basis-[420px] flex-wrap rule-l max-[999px]:border-l-0 max-[999px]:rule-t"
        >
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
              className="relative h-11 min-w-0 flex-1 basis-[180px] overflow-hidden bg-raised hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-live"
              style={{ borderLeft: i > 0 ? "var(--rule-thin) solid var(--color-line)" : undefined }}
            >
              {/* The range frequency, printed as an action-ink band along the foot of
                  the block: an ink is a fill here and never has to carry text. */}
              {/* `backgroundColor`, never the `background` shorthand: the shorthand
                  resets background-image and kills `.hatch`'s overprint. */}
              <span
                className={`absolute bottom-0 left-0 h-2.5 ${hatched(a.label) ? "hatch" : ""}`}
                style={{ width: `${(freqs[i] ?? 0) * 100}%`, backgroundColor: colors[i] }}
              />
              <span className="relative z-[1] flex h-full items-center gap-2 px-2.5 pb-2.5">
                <span
                  aria-hidden
                  className={`h-2 w-2 flex-none ${hatched(a.label) ? "hatch" : ""}`}
                  style={{ backgroundColor: colors[i] }}
                />
                <span
                  className="uppercase text-text"
                  style={{ font: "600 11px/1 var(--font-condensed)", letterSpacing: ".15em" }}
                >
                  {a.text}
                </span>
                {a.percent_of_pot != null && (
                  <span className="num text-dim" style={{ fontSize: 11 }}>
                    {a.percent_of_pot.toFixed(0)}%
                  </span>
                )}
                <span
                  className="num ml-auto text-text"
                  style={{ fontSize: 17, fontWeight: 700 }}
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

/**
 * The 8px square that names one step of the line: an action ink in the tree (bet red,
 * check green under the overprint hatch, fold blue), a hairline square for a dealt card,
 * stock white at the root. On the current chip, which is knocked out to stock white, the
 * root square flips to the plate ground so it stays visible.
 */
function StepSquare({ step, current }: { step: PathStep | null; current: boolean }) {
  const label = step && step.kind === "action" ? step.token.split(":")[0] : null;
  const ink =
    label === null
      ? step
        ? "var(--color-line)"
        : current
          ? "var(--color-paper)"
          : "var(--color-ink)"
      : label === "fold"
        ? "var(--color-fold)"
        : label === "check" || label === "call"
          ? "var(--color-check)"
          : "var(--color-bet)";
  return (
    <span
      aria-hidden
      className={`h-2 w-2 flex-none ${hatched(label ?? "") ? "hatch" : ""}`}
      style={{ backgroundColor: ink }}
    />
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
    <div className="inline-flex flex-col" style={{ background: "var(--color-line)", padding: 2, gap: 2 }}>
      {hotness && hotness.maxDeviation > 0 && (
        /* The caption sits on the lattice's own gap ink (--color-line), not on the
           plate, so it needs `muted` (7.0:1 there); `dim-inv` measures 4.02:1. */
        <div className="label px-1 py-1" style={{ color: "var(--color-muted)" }}>
          shaded by hero EV vs the runout average
        </div>
      )}
      {SUITS.split("").map((suit) => (
        <div key={suit} className="flex" style={{ gap: 2 }}>
          <span
            className={`num flex w-[22px] items-center justify-center ${SUIT_CLASS[suit]}`}
            style={{ background: "var(--color-paper-2)", fontSize: 13 }}
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
                /* The tint is an ink mixed INTO the plate, so it is always dark: the
                   rank on it stays stock white (7.7:1 at the greenest, 9.6:1 at the
                   reddest), never the plate colour. */
                style={tint ? { background: tint, color: "var(--color-text)" } : undefined}
                className={[
                  "num font-bold transition-colors",
                  cellCls,
                  child === undefined
                    ? dead
                      ? "cursor-not-allowed bg-paper-2 text-dim-inv line-through"
                      : "cursor-not-allowed bg-paper-2 text-line"
                    : tint
                      ? "cursor-pointer hover:!bg-ink hover:!text-paper"
                      : `cursor-pointer bg-raised hover:!bg-ink hover:!text-paper ${SUIT_CLASS[suit]}`,
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
