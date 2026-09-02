"use client";

import { ComboCards } from "@/components/Card";
import { Cell, cellOf, comboFreqs, comboRegret, hatched } from "@/lib/grid";
import type { Combo, NodeAction } from "@/lib/types";

interface Props {
  cell: Cell | null;
  combos: Combo[];
  strategy: Float32Array;
  evs: Float32Array;
  /** Per-action combo_evs(), one Float32Array per action, same slot order as `combos`. */
  actionEvs: Float32Array[];
  actions: NodeAction[];
  colors: string[];
  /** Range-wide frequency per action (view.freqs), for the no-selection ladder. */
  freqs: number[];
  player: string;
  /** The solution's `meta().payoff_unit`. Under `"cste"` these EVs are tournament
   *  equity, not big blinds, and are NOT zero-sum, the footnote below says which. */
  unit?: "chips" | "cste";
  /** Jump the grid selection to a cell, wired from the top-regret rows. */
  onPickCell: (c: { row: number; col: number }) => void;
}

export default function ComboPanel({
  cell,
  combos,
  strategy,
  evs,
  actionEvs,
  actions,
  colors,
  freqs,
  player,
  unit,
  onPickCell,
}: Props) {
  const n = combos.length;

  if (!cell) {
    return (
      <NodeOverview
        combos={combos}
        strategy={strategy}
        actionEvs={actionEvs}
        actions={actions}
        colors={colors}
        freqs={freqs}
        onPickCell={onPickCell}
      />
    );
  }

  const rows = cell.slots.map((slot) => ({
    slot,
    combo: combos[slot],
    freqs: comboFreqs(strategy, actions.length, n, slot),
    ev: evs[slot],
  }));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <h2 className="bar bar-strategy">
        <span style={{ font: "800 22px/1 var(--font-sans)", letterSpacing: "-.03em", textTransform: "none" }}>
          {cell.label}
        </span>
        <span className="meta">
          {rows.length} combo{rows.length === 1 ? "" : "s"} · {player} · weight {cell.weight.toFixed(3)}
        </span>
      </h2>

      {cell.noReach && (
        <p
          className="bg-accent px-2.5 py-2 uppercase text-accent-ink"
          style={{ font: "600 10px/1.4 var(--font-condensed)", letterSpacing: ".15em" }}
        >
          Zero reach · frequencies below are the stored strategy, unweighted
        </p>
      )}

      <div
        className="combo-rows rule-b bg-paper-2 px-2.5 py-1.5"
        style={{ "--nact": actions.length } as React.CSSProperties}
      >
        <span className="label">hand</span>
        <span className="label text-right">weight</span>
        <span className="label">strategy</span>
        {actions.map((a, i) => (
          <span key={i} className="label flex items-center justify-end gap-1 truncate" title={a.text}>
            <span
              className={`h-2.5 w-2.5 shrink-0 ${hatched(a.label) ? "hatch" : ""}`}
              style={{ backgroundColor: colors[i] }}
            />
            {a.label}
          </span>
        ))}
        <span className="label text-right">EV</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(({ slot, combo, freqs: f, ev }) => (
          <div
            key={slot}
            className="combo-rows rule-b h-[32px] px-2.5 hover:bg-ink-2"
            style={{ "--nact": actions.length } as React.CSSProperties}
          >
            <ComboCards cards={combo.cards} variant="stock" size={10} />
            <span className="num text-right text-muted">{combo.weight.toFixed(3)}</span>
            <MixBar freqs={f} actions={actions} colors={colors} />
            {/* Neutral ink, not the action colour: the light ramp ends fail AA as
                11px text on paper, the head-row swatch carries the colour coding. */}
            {actions.map((a, i) => {
              const v = actionEvs[i]?.[slot] ?? NaN;
              return (
                <span
                  key={i}
                  className={`num text-right text-[11px] ${Number.isNaN(v) ? "text-dim" : "text-muted"}`}
                  title={`${a.text} EV: ${Number.isNaN(v) ? "no defined EV" : v.toFixed(3)}`}
                >
                  {Number.isNaN(v) ? "–" : v.toFixed(2)}
                </span>
              );
            })}
            <span
              className={`num text-right ${Number.isNaN(ev) ? "text-dim" : ev >= 0 ? "text-ok" : "text-err"}`}
              title={
                Number.isNaN(ev)
                  ? "No defined EV: the opponent's range cannot reach this node holding anything this hand does not block."
                  : undefined
              }
            >
              {Number.isNaN(ev) ? "–" : ev.toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <div className="rule-t bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
        {unit === "cste"
          ? "EV is tournament equity in CSTE chips, measured against the start of the solve, both players on the solved average strategy. It is not zero-sum: the pair leaks equity to the rest of the table when the hand pushes their stacks apart, and draws equity back from it when the hand pulls them together."
          : "EV is zero-sum net big blinds from the start of the solve, both players on the solved average strategy."}{" "}
        “–” means the EV is undefined here, not zero.
      </div>
    </div>
  );
}

/**
 * No cell selected: aggregate the whole node instead of asking for a click, the
 * action EV ladder, then the 20 combos leaving the most chips on the table.
 */
function NodeOverview({
  combos,
  strategy,
  actionEvs,
  actions,
  colors,
  freqs,
  onPickCell,
}: {
  combos: Combo[];
  strategy: Float32Array;
  actionEvs: Float32Array[];
  actions: NodeAction[];
  colors: string[];
  freqs: number[];
  onPickCell: (c: { row: number; col: number }) => void;
}) {
  const n = combos.length;

  // Reach-weighted mean EV per action, NaN slots skipped.
  const ladder = actions
    .map((a, i) => {
      let sum = 0;
      let w = 0;
      for (let s = 0; s < n; s++) {
        const v = actionEvs[i]?.[s] ?? NaN;
        if (Number.isNaN(v)) continue;
        sum += combos[s].weight * v;
        w += combos[s].weight;
      }
      return { action: a, i, freq: freqs[i] ?? 0, mean: w > 0 ? sum / w : NaN };
    })
    .sort((a, b) => (Number.isNaN(b.mean) ? -Infinity : b.mean) - (Number.isNaN(a.mean) ? -Infinity : a.mean));

  const regrets = combos
    .map((c, s) => ({ combo: c, slot: s, regret: comboRegret(actionEvs, strategy, actions.length, n, s) }))
    .filter((r) => Number.isFinite(r.regret));
  regrets.sort((a, b) => b.regret - a.regret);
  const top = regrets.slice(0, 20);
  const undefinedCount = n - regrets.length;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <h2 className="bar">
        Node overview
        <span className="meta">
          {n} combos · no cell selected · click any cell to drill in
        </span>
      </h2>

      <div className="label rule-b bg-paper-2 px-2.5 py-1.5">Action EV ladder</div>
      <div>
        {ladder.map(({ action, i, freq, mean }) => (
          <div key={i} className="rule-b flex h-[34px] items-center gap-2.5 px-2.5">
            <span
              className={`h-3 w-3 shrink-0 ${hatched(action.label) ? "hatch" : ""}`}
              style={{ backgroundColor: colors[i] }}
            />
            <span className="num">{action.text}</span>
            <span className="num text-dim">{(freq * 100).toFixed(1)}%</span>
            <span className="fig fig-3 ml-auto">{Number.isNaN(mean) ? "–" : mean.toFixed(3)}</span>
          </div>
        ))}
      </div>

      <div className="label rule-t rule-b bg-paper-2 px-2.5 py-1.5">
        Top {top.length} by regret
        {undefinedCount > 0 ? ` · ${undefinedCount} combos have no defined regret` : ` · ${regrets.length} combos scored`}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {top.map(({ combo, slot, regret }) => (
          <button
            key={slot}
            onClick={() => onPickCell(cellOf(combo.cards))}
            className="rule-b grid h-[32px] w-full grid-cols-[64px_52px_minmax(0,1fr)_74px] items-center gap-x-2 px-2.5 text-left hover:bg-ink-2"
            title={`Select ${combo.cards.slice(0, 2)} ${combo.cards.slice(2, 4)} in the grid`}
          >
            <ComboCards cards={combo.cards} variant="stock" size={10} />
            <span className="num text-right text-muted">{combo.weight.toFixed(3)}</span>
            <MixBar
              freqs={comboFreqs(strategy, actions.length, n, slot)}
              actions={actions}
              colors={colors}
            />
            <span className="fig fig-3 text-right text-err">{regret.toFixed(3)}</span>
          </button>
        ))}
      </div>

      <div className="rule-t bg-paper-2 px-2.5 py-2 text-[11px] text-muted">
        Regret is the big blinds a combo leaves on the table by mixing instead of always taking
        its best action. Click a row to open that hand class in the grid.
      </div>
    </div>
  );
}

/**
 * Stock white or plate ink, whichever survives on this band. The band colours are
 * an action ramp, not a fixed pair, so the number's ink is picked from the fill's
 * own relative luminance rather than guessed: the crossover sits at L .19, where
 * both choices measure 4.4:1, and every real ramp entry lands well clear of it.
 */
function bandInk(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  // Whichever of the two inks actually wins on THIS band, not a fixed crossover: a
  // number printed on the mid-lightness action inks (bet #e8202f L .184, fold #3b6bff
  // L .187) clears 4.5:1 against black and only 4.0:1 against stock, so a crossover
  // tuned for the ends of the ramp fails in the middle. Black rather than the deepest
  // token well (#0e110d, 4.24:1 on bet) because that is the one overprint that clears
  // 4.5:1 on all eight action inks. Measured min across the ramp: 4.68:1.
  const dark = (l + 0.05) / 0.05;
  const stock = 0.9301 / (l + 0.05);
  return dark >= stock ? "#000000" : "#f0f3f0";
}

/** One combo's action mix: the bands carry their own frequency, printed inside. */
function MixBar({
  freqs,
  actions,
  colors,
}: {
  freqs: number[];
  actions: NodeAction[];
  colors: string[];
}) {
  return (
    <span className="flex h-[20px] overflow-hidden bg-ink-2">
      {freqs.map((v, a) => (
        <span
          key={a}
          /* `.hatch` is a background-IMAGE, so the ink under it is a background-COLOR. */
          className={`relative ${hatched(actions[a]?.label ?? "") ? "hatch" : ""}`}
          style={{ width: `${v * 100}%`, backgroundColor: colors[a] }}
          title={`${actions[a]?.text ?? a}: ${(v * 100).toFixed(1)}%`}
        >
          {v >= 0.18 && (
            <span
              className="absolute inset-0 grid place-items-center"
              style={{
                font: "700 9.5px/1 var(--font-mono)",
                letterSpacing: "-.03em",
                color: bandInk(colors[a] ?? "#000000"),
              }}
            >
              {(v * 100).toFixed(0)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
