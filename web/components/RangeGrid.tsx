"use client";

import { Fragment } from "react";
import { Cell, CellEv, evColor, fmtChips, regretColor, RANKS } from "@/lib/grid";
import type { NodeAction } from "@/lib/types";

interface Props {
  cells: Cell[];
  /** One CSS colour per action index, from `actionColors`. */
  colors: string[];
  /**
   * `strategy`: stacked action-frequency bars. `reach`: range density only.
   * `ev`: highest-EV action per hand, faded toward ivory when near-indifferent.
   * `regret`: big blinds lost by not always taking the best action, ivory to red.
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
        font: "700 9px/1 var(--font-mono)",
        color: lit ? "var(--color-text-inv)" : "var(--color-dim-inv)",
        background: lit ? "var(--color-live)" : "var(--color-ink)",
        minHeight: kind === "col" ? "var(--axis)" : undefined,
      }}
    >
      {RANKS[i]}
    </span>
  );

  return (
    <div
      role="group"
      aria-label="13 by 13 range grid, ranks A to 2"
      style={{
        display: "grid",
        gridTemplateColumns: large
          ? "var(--axis) repeat(13, minmax(0, 1fr))"
          : "repeat(13, minmax(0, 1fr))",
        gap: "2px",
        padding: "2px",
        background: "var(--color-ink)",
      }}
    >
      {large && (
        <>
          <span aria-hidden style={{ background: "var(--color-ink)" }} />
          {RANKS.split("").map((_, i) => axis("col", i, selected?.col === i))}
        </>
      )}
      {cells.map((cell, idx) => {
        const empty = cell.slots.length === 0;
        const isSel = selected?.row === cell.row && selected?.col === cell.col;
        const density = cell.weight / maxWeight;
        const cellEv = evCells?.[idx];
        const evFill = cellEv ? evColor(cellEv, colors, maxMargin) : null;
        const regretFill = cellEv ? regretColor(cellEv.regret, maxRegret) : null;

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
              onClick={() => onSelect?.(cell)}
              title={title}
              data-cell={cell.label}
              className={[
                "relative aspect-square overflow-hidden transition-[outline-color]",
                large ? "text-[11px]" : "text-[8px]",
                empty || !onSelect ? "cursor-default" : "cursor-pointer",
                "bg-[#1c1c1a]",
                cell.noReach && !empty ? "opacity-30" : "",
                isSel ? "outline outline-[3px] -outline-offset-[3px] outline-live z-10" : "",
                !empty && onSelect
                  ? "hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-accent"
                  : "",
              ].join(" ")}
            >
              {!empty && mode === "reach" && (
                <span
                  className="absolute inset-0"
                  style={{ background: colors[0] ?? "#48566f", opacity: 0.12 + 0.78 * density }}
                />
              )}
              {!empty && mode === "strategy" && (
                <span className="absolute inset-0 flex">
                  {cell.freqs.map((f, a) => (
                    <span
                      key={a}
                      style={{ width: `${f * 100}%`, background: colors[a] }}
                      className="h-full"
                    />
                  ))}
                </span>
              )}
              {!empty && mode === "ev" && evFill && (
                <span className="absolute inset-0" style={{ background: evFill }} />
              )}
              {!empty && mode === "regret" && regretFill && (
                <span className="absolute inset-0" style={{ background: regretFill }} />
              )}
              <span
                className={[
                  "num relative z-[1] flex h-full w-full items-center justify-center font-bold",
                  empty
                    ? "text-[#4a4842]"
                    : mode === "ev" || mode === "regret"
                      ? "text-[#101010] [text-shadow:0_1px_1px_rgba(244,241,232,.55)]"
                      : "text-white [text-shadow:0_1px_2px_rgba(0,0,0,.85)]",
                ].join(" ")}
              >
                {large || cell.row === cell.col ? cell.label : ""}
              </span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
