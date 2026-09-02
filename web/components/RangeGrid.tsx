"use client";

import { Fragment, useRef } from "react";
import { Cell, CellEv, evColor, fmtChips, hatched, RANKS, rampMix, regretColor } from "@/lib/grid";
import type { NodeAction } from "@/lib/types";

/* FOUR PLATES. Every cell is a small printed object: a label strip on the raised
   plate carrying the hand in Azeret, over a proportion bar split bet | check | fold
   in the action inks, with the 45 degree overprint on the check band. Hands that do
   not participate drop to the dim ground so the live region reads as a shape.
   The single-ink modes (reach, ev, regret) are opacity ramps on the plate, never a
   blend toward a light stock: nothing on this ground goes pale. */

/** Off-range ground and its label. Two literals, both dim ends of the spade plate. */
const DEAD_BG = "#191d17";
const DEAD_LABEL = "#828b81"; // 4.85:1 on DEAD_BG; the mock's #5a6158 measured 2.67:1
/** Reach has no action to name, so it prints on the diamond plate: --color-card-d. */
const REACH_INK = "#5b8cff";

/** Row/column step per arrow key, for the roving tabindex. */
const ARROWS: Record<string, [number, number] | undefined> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

interface Props {
  cells: Cell[];
  /** One CSS colour per action index, from `actionColors`. */
  colors: string[];
  /**
   * `strategy`: stacked action-frequency bars. `reach`: range density only.
   * `ev`: highest-EV action per hand, faded toward the plate when near-indifferent.
   * `regret`: big blinds lost by not always taking the best action, heart-lit ramp.
   */
  mode: "strategy" | "reach" | "ev" | "regret";
  /** Required for `ev`/`regret`, same 169-length order as `cells`. */
  evCells?: CellEv[];
  /** Required for `ev`, to name the best action in the hover title. */
  actions?: NodeAction[];
  size: "large" | "small";
  selected?: { row: number; col: number } | null;
  onSelect?: (cell: Cell) => void;
}

export default function RangeGrid({
  cells,
  colors,
  mode,
  evCells,
  actions,
  size,
  selected,
  onSelect,
}: Props) {
  const large = size === "large";
  const wrap = useRef<HTMLDivElement>(null);
  /* Roving tabindex: without it a keyboard user pays 73 Tab presses to cross one grid,
     twice over on the inspector. One stop per grid, arrows walk the live cells. */
  const firstLive = cells.findIndex((c) => c.slots.length > 0);
  const selIdx = selected ? selected.row * 13 + selected.col : -1;
  const rover = selIdx >= 0 && (cells[selIdx]?.slots.length ?? 0) > 0 ? selIdx : firstLive;

  const arrowMove = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = ARROWS[e.key];
    if (!step || !onSelect || rover < 0) return;
    let row = Math.floor(rover / 13);
    let col = rover % 13;
    for (let i = 0; i < 13; i++) {
      row += step[0];
      col += step[1];
      if (row < 0 || row > 12 || col < 0 || col > 12) return;
      const next = cells[row * 13 + col];
      if (next && next.slots.length > 0) {
        e.preventDefault();
        onSelect(next);
        wrap.current?.querySelector<HTMLElement>(`[data-cell="${next.label}"]`)?.focus();
        return;
      }
    }
  };
  /* The bar is a proportion of the cell, not a fixed height: the mock's 14px sat on a
     46px cell, and the same 30% keeps that ratio when the column is narrower. */
  const barH = "30%";
  const maxWeight = Math.max(1e-9, ...cells.map((c) => c.weight));
  const maxMargin = Math.max(
    1e-9,
    ...(evCells ?? []).filter((c) => Number.isFinite(c.margin)).map((c) => c.margin),
  );
  const maxRegret = Math.max(
    1e-9,
    ...(evCells ?? []).map((c) => (Number.isNaN(c.regret) ? 0 : c.regret)),
  );

  const axis = (kind: "row" | "col", i: number, lit: boolean) => (
    <span
      key={`${kind}-${i}`}
      aria-hidden
      className="flex items-center justify-center"
      style={{
        font: `500 ${large ? 10 : 8}px/1 var(--font-mono)`,
        letterSpacing: "-.02em",
        color: lit ? "var(--color-text)" : "var(--color-dim)",
        minHeight: kind === "col" ? "var(--axis)" : undefined,
      }}
    >
      {RANKS[i]}
    </span>
  );

  return (
    <div
      ref={wrap}
      role="group"
      aria-label="13 by 13 range grid, ranks A to 2"
      onKeyDown={arrowMove}
      style={{
        display: "grid",
        gridTemplateColumns: large
          ? "var(--axis) repeat(13, minmax(0, 1fr))"
          : "repeat(13, minmax(0, 1fr))",
        gap: "2px",
        background: "var(--color-paper)",
      }}
    >
      {large && (
        <>
          <span aria-hidden />
          {RANKS.split("").map((_, i) => axis("col", i, selected?.col === i))}
        </>
      )}
      {cells.map((cell, idx) => {
        const empty = cell.slots.length === 0;
        const isSel = selected?.row === cell.row && selected?.col === cell.col;
        const density = cell.weight / maxWeight;
        const cellEv = evCells?.[idx];

        // The single-ink modes are one solid ground mixed by `rampMix`, the same
        // function the legend swatches call, so the two can never drift. Its ceiling
        // keeps the stock-white label above 4.5:1 on every ink.
        const ground = empty
          ? DEAD_BG
          : mode === "reach"
            ? rampMix(REACH_INK, density)
            : mode === "ev"
              ? (cellEv ? evColor(cellEv, colors, maxMargin) : null) ?? "var(--color-raised)"
              : mode === "regret"
                ? regretColor(cellEv?.regret ?? NaN, maxRegret) ?? "var(--color-raised)"
                : "var(--color-raised)";

        const title = empty
          ? `${cell.label}: no live combos here`
          : mode === "ev"
            ? cellEv && cellEv.bestAction >= 0
              ? `${cell.label}: best ${actions?.[cellEv.bestAction]?.text ?? cellEv.bestAction}, margin ${fmtChips(cellEv.margin === Infinity ? 0 : cellEv.margin)} bb`
              : `${cell.label}: no EV data`
            : mode === "regret"
              ? `${cell.label}: EV lost ${Number.isNaN(cellEv?.regret ?? NaN) ? "no data" : fmtChips(cellEv!.regret) + " bb"}`
              : `${cell.label}: ${cell.slots.length} combo${cell.slots.length > 1 ? "s" : ""}, weight ${cell.weight.toFixed(2)}`;

        return (
          <Fragment key={`${cell.row}-${cell.col}`}>
            {large && cell.col === 0 && axis("row", cell.row, selected?.row === cell.row)}
            <button
              type="button"
              disabled={empty || !onSelect}
              tabIndex={idx === rover ? 0 : -1}
              onClick={() => onSelect?.(cell)}
              title={title}
              data-cell={cell.label}
              className={[
                "relative grid aspect-square overflow-hidden",
                empty || !onSelect ? "cursor-default" : "cursor-pointer",
                isSel ? "outline outline-2 -outline-offset-2 outline-live z-10" : "",
                !empty && onSelect
                  ? "hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-dim"
                  : "",
              ].join(" ")}
              style={{
                gridTemplateRows: `minmax(0,1fr) ${!empty && mode === "strategy" ? barH : "0px"}`,
                background: ground,
              }}
            >
              <span
                className="relative z-[1] flex items-center justify-center"
                style={{
                  font: `500 ${large ? 11 : 8}px/1 var(--font-mono)`,
                  letterSpacing: "-.04em",
                  color: empty ? DEAD_LABEL : "var(--color-text)",
                }}
              >
                {large || cell.row === cell.col ? cell.label : ""}
              </span>

              {/* The proportion bar: the printed half of the object. Its `ink-2`
                  track matters: a hand class whose combos are partly dead on this
                  board sums to less than 1, and without a track the short bar reads
                  as a rendering fault instead of as dead combos. */}
              {!empty && mode === "strategy" && (
                <span
                  className={`relative z-[1] flex ${cell.noReach ? "opacity-40" : ""}`}
                  style={{ backgroundColor: "var(--color-ink-2)" }}
                >
                  {cell.freqs.map((f, a) => (
                    <span
                      key={a}
                      /* `.hatch` paints the overprint as a background-IMAGE, so the ink
                         underneath it must be set as background-color: the `background`
                         shorthand inline would blow the image away. */
                      className={hatched(actions?.[a]?.label ?? "") ? "hatch" : ""}
                      style={{ width: `${f * 100}%`, backgroundColor: colors[a] }}
                    />
                  ))}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
