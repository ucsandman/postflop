"use client";

import { Cell, RANKS } from "@/lib/grid";

interface Props {
  cells: Cell[];
  /** One CSS colour per action index, from `actionColors`. */
  colors: string[];
  /** `strategy`: stacked action-frequency bars. `reach`: range density only. */
  mode: "strategy" | "reach";
  size: "large" | "small";
  selected?: { row: number; col: number } | null;
  onSelect?: (cell: Cell) => void;
}

export default function RangeGrid({ cells, colors, mode, size, selected, onSelect }: Props) {
  const large = size === "large";
  const maxWeight = Math.max(1e-9, ...cells.map((c) => c.weight));

  return (
    <div
      className="grid gap-px bg-line-soft p-px"
      style={{ gridTemplateColumns: "repeat(13, minmax(0, 1fr))" }}
    >
      {cells.map((cell) => {
        const empty = cell.slots.length === 0;
        const isSel = selected?.row === cell.row && selected?.col === cell.col;
        const density = cell.weight / maxWeight;

        return (
          <button
            key={`${cell.row}-${cell.col}`}
            type="button"
            disabled={empty || !onSelect}
            onClick={() => onSelect?.(cell)}
            title={
              empty
                ? `${cell.label} — no live combos here`
                : `${cell.label} — ${cell.slots.length} combo${cell.slots.length > 1 ? "s" : ""}, weight ${cell.weight.toFixed(2)}`
            }
            data-cell={cell.label}
            className={[
              "relative aspect-square overflow-hidden transition-[outline-color]",
              large ? "text-[10px]" : "text-[7px]",
              empty || !onSelect ? "cursor-default" : "cursor-pointer",
              empty ? "bg-[#0b0f16]" : "bg-[#0d121a]",
              cell.noReach && !empty ? "opacity-30" : "",
              isSel ? "outline outline-2 -outline-offset-2 outline-accent z-10" : "",
              !empty && onSelect
                ? "hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-[#5b6b86]"
                : "",
            ].join(" ")}
          >
            {!empty && mode === "reach" && (
              <span
                className="absolute inset-0"
                style={{ background: colors[0] ?? "#3f6fa8", opacity: 0.12 + 0.78 * density }}
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
            <span
              className={[
                "num relative z-[1] flex h-full w-full items-center justify-center font-semibold",
                empty ? "text-[#2c3442]" : "text-white/95 [text-shadow:0_1px_2px_rgba(0,0,0,.75)]",
              ].join(" ")}
            >
              {large || cell.row === cell.col ? cell.label : ""}
            </span>
          </button>
        );
      })}
      {/* rank axis is implicit in the labels; keeping the grid to 169 cells exactly */}
      <span className="sr-only">{RANKS}</span>
    </div>
  );
}
