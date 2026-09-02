"use client";

// Interactive 13x13 range editor. One instance per seat; the Solve tab puts the two
// side by side (they are narrow enough to read at 13 columns and comparing OOP against
// IP is the whole point of a postflop spot).
//
// The form still stores a range STRING, exactly as before, that is what goes into the
// TOML. This component is a two-way view on it: painting the grid regenerates a
// canonical string, and typing a string repaints the grid through the engine's own
// `parse_range`, so what you see is what the solver will read and never a JS guess at it.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLASS_LABELS,
  NUM_CLASSES,
  canonicalRange,
  classMap,
  classWeights,
  comboCount,
  rangeSize,
  topWeights,
} from "@/lib/range";
import { rampMix } from "@/lib/grid";
import { loadWasm } from "@/lib/wasm";

/** Weight reads as a single-ink opacity ramp on the diamond plate, the same ink the
 *  Inspector's opponent-reach grid uses. Zero-weight cells drop to the off-range
 *  ground so the range reads as a shape before any number is read. */
/** The diamond plate, as a literal: `rampMix` mixes it, so it cannot be a var(). */
const FILL = "#5b8cff";
const DEAD_BG = "#191d17";
const DEAD_LABEL = "#828b81"; // 4.85:1 on DEAD_BG; the mock's #5a6158 measured 2.67:1

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** wasm + the 1326 -> 169 class map, loaded once for the whole page. */
let engine: Promise<{ expand: (range: string) => number[]; map: Int16Array }> | null = null;
const getEngine = () =>
  (engine ??= loadWasm().then((wasm) => ({
    expand: (range: string) => (JSON.parse(wasm.parse_range(range)) as { weights: number[] }).weights,
    map: classMap(JSON.parse(wasm.combo_labels()) as string[]),
  })));

/** Row/column step per arrow key, for the grid's roving tabindex. */
const ARROWS: Record<string, [number, number] | undefined> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

export default function RangeEditor({
  seat,
  value,
  onChange,
}: {
  seat: "oop" | "ip";
  value: string;
  onChange: (range: string) => void;
}) {
  const [weights, setWeights] = useState<number[]>(() => new Array(NUM_CLASSES).fill(0));
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** null once a hand edit diverges from the slider, the slider then reads "custom". */
  const [topPct, setTopPct] = useState<number | null>(null);
  const [brush, setBrush] = useState(100);
  const [hover, setHover] = useState<number | null>(null);
  /** The grid's single tab stop. Arrow keys move it; every other cell is tabIndex -1. */
  const [rover, setRover] = useState(0);

  /** The last string this editor handed the form, so an echo back does not re-parse. */
  const emitted = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Weight painted for the duration of one drag; null when not painting. */
  const painting = useRef<number | null>(null);
  /** Where the pointer was on the previous move, so a fast drag skips no cells. */
  const last = useRef<{ x: number; y: number } | null>(null);
  /** Live weights during a drag, state lags a fast pointer, a ref does not. */
  const draft = useRef<number[]>(weights);

  // Incoming string (a preset, or the first render) -> grid.
  useEffect(() => {
    if (value === emitted.current) return;
    setText(value);
    let stale = false;
    getEngine()
      .then(({ expand, map }) => {
        if (stale) return;
        setReady(true);
        try {
          setWeights(classWeights(expand(value), map));
          setError(null);
        } catch (e) {
          setError(message(e));
        }
        setTopPct(null);
      })
      .catch((e) => setError(message(e)));
    return () => {
      stale = true;
    };
  }, [value]);

  const emit = useCallback(
    (next: number[], pct: number | null) => {
      const range = canonicalRange(next);
      setWeights(next);
      setTopPct(pct);
      setText(range);
      setError(null);
      emitted.current = range;
      onChange(range);
    },
    [onChange],
  );

  /** Typed text is the source of truth until the next grid edit, parse it, don't rewrite it. */
  const onText = (next: string) => {
    setText(next);
    getEngine()
      .then(({ expand, map }) => {
        let parsed: number[];
        try {
          parsed = classWeights(expand(next), map);
        } catch (e) {
          setError(message(e));
          return;
        }
        setError(null);
        setWeights(parsed);
        setTopPct(null);
        emitted.current = next;
        onChange(next);
      })
      .catch((e) => setError(message(e)));
  };

  const paint = (index: number, weight: number) => {
    if (draft.current[index] === weight) return;
    const next = draft.current.slice();
    next[index] = weight;
    draft.current = next;
    setWeights(next);
  };

  /** Hit-test rather than rely on pointerenter: the grid holds the pointer capture. */
  const cellUnder = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const idx = (el as HTMLElement | null)?.closest<HTMLElement>("[data-index]")?.dataset.index;
    return idx === undefined ? null : Number(idx);
  };

  /** Clicking a cell that already holds the brush weight clears it; everything else,
   *  including every cell a drag then crosses, is set to the brush. */
  const brushValue = (index: number) =>
    Math.abs(weights[index] - brush / 100) < 1e-9 ? 0 : brush / 100;

  const startPaint = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const index = Number(e.currentTarget.dataset.index);
    const value = brushValue(index);
    draft.current = weights;
    painting.current = value;
    last.current = { x: e.clientX, y: e.clientY };
    gridRef.current?.setPointerCapture(e.pointerId);
    paint(index, value);
  };

  const movePaint = (e: React.PointerEvent) => {
    if (painting.current === null) return;
    // One pointermove can span several cells on a fast drag, so walk the segment from
    // the last position rather than sampling only where the pointer landed.
    const from = last.current ?? { x: e.clientX, y: e.clientY };
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 8));
    for (let s = 1; s <= steps; s++) {
      const index = cellUnder(from.x + (dx * s) / steps, from.y + (dy * s) / steps);
      if (index !== null) paint(index, painting.current);
    }
    last.current = { x: e.clientX, y: e.clientY };
  };

  /** Keyboard equivalent of a single click, plus the arrow keys that move the one tab
   *  stop around the grid. Without the roving tabindex all 169 cells sit in the tab
   *  order and the Solve button is stop 390 of 391. */
  const keyPaint = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = Number(e.currentTarget.dataset.index);
    const step = ARROWS[e.key];
    if (step) {
      const row = Math.floor(index / 13) + step[0];
      const col = (index % 13) + step[1];
      if (row < 0 || row > 12 || col < 0 || col > 12) return;
      e.preventDefault();
      const next = row * 13 + col;
      setRover(next);
      gridRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const next = weights.slice();
    next[index] = brushValue(index);
    emit(next, null);
  };

  const endPaint = () => {
    if (painting.current === null) return;
    painting.current = null;
    last.current = null;
    emit(draft.current, null);
  };

  const { combos, pct } = rangeSize(weights);
  const rounded = Math.round(combos * 10) / 10;
  const label = seat.toUpperCase();

  return (
    <div
      style={{ border: "var(--rule-thin) solid var(--color-line)", padding: 10 }}
      data-testid={`range-editor-${seat}`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="label">{label} range</span>
        <span className="num text-muted" style={{ fontSize: 11 }} data-testid={`range-count-${seat}`}>
          {Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} combos ({pct.toFixed(1)}%)
        </span>
      </div>

      <div
        ref={gridRef}
        onPointerMove={movePaint}
        onPointerUp={endPaint}
        onLostPointerCapture={endPaint}
        onPointerLeave={() => setHover(null)}
        data-testid={`range-grid-${seat}`}
        className={`grid touch-none select-none ${ready ? "" : "opacity-40"}`}
        style={{
          gridTemplateColumns: "repeat(13, minmax(0, 1fr))",
          background: "var(--color-paper)",
          gap: 2,
        }}
      >
        {CLASS_LABELS.map((cell, index) => {
          const w = weights[index] ?? 0;
          return (
            <button
              key={cell}
              type="button"
              data-index={index}
              data-cell={cell}
              aria-label={`${cell} ${Math.round(w * 100)}%`}
              title={`${cell}, ${comboCount(index)} combos · ${Math.round(w * 100)}%`}
              tabIndex={index === rover ? 0 : -1}
              onFocus={() => setRover(index)}
              onPointerDown={startPaint}
              onKeyDown={keyPaint}
              onPointerEnter={() => setHover(index)}
              className="relative aspect-square cursor-pointer overflow-hidden hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-dim focus-visible:z-10"
              /* One ink, its strength carrying the weight: a cell at 25% is a
                 quarter-strength print of the same plate, not a different colour.
                 `rampMix` is the same mixer the strategy grid uses, and its ceiling
                 keeps the stock-white label above 4.5:1 on a full-weight cell. */
              style={{
                background: w > 0 ? rampMix(FILL, w) : DEAD_BG,
                containerType: "inline-size",
              }}
            >
              {/* `.num` hard-sets 13px, which "AKs" cannot fit into below a ~24px cell,
                  the Solve tab's two-up column gives 18px cells at 1500–1899px and the
                  labels were clipped. 50cqw of the cell keeps three mono glyphs inside it
                  and caps at the 13px this reads as everywhere the cell is wide enough. */}
              <span
                className="num relative z-[1] flex h-full w-full items-center justify-center"
                style={{
                  fontSize: "min(12px, 50cqw)",
                  fontWeight: 500,
                  letterSpacing: "-.04em",
                  color: w > 0 ? "var(--color-text)" : DEAD_LABEL,
                }}
              >
                {cell}
              </span>
            </button>
          );
        })}
      </div>

      {/* minmax(0,...) or the range inputs' intrinsic width blows the track out. */}
      <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <span className="label">brush</span>
        {/* Wraps: the four preset blocks have a 196px min-content width, so in the
            Solve tab's two-up column they ate the whole row, the slider collapsed
            to 0px and the readout spilled past the editor's ink border. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="seg">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={brush === p}
                onClick={() => setBrush(p)}
                data-testid={`brush-${p}-${seat}`}
              >
                {p}%
              </button>
            ))}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={brush}
            aria-label={`${label} brush weight`}
            data-testid={`brush-slider-${seat}`}
            onChange={(e) => setBrush(Number(e.target.value))}
            /* basis-20, not basis-0: with a 0 basis the track never forces a wrap, so
               next to the 196px preset blocks it grew to 14px, a bare thumb on a track
               too short to drag. At 80px it wraps to its own line and grows there. */
            className="min-w-0 flex-1 basis-20"
          />
          <span className="num w-8 text-right text-muted" style={{ fontSize: 11 }}>
            {brush}%
          </span>
        </div>

        <span className="label">top&nbsp;%</span>
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={topPct ?? 0}
            aria-label={`${label} strongest percent of combos`}
            data-testid={`range-top-${seat}`}
            onChange={(e) => emit(topWeights(Number(e.target.value)), Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="num w-14 text-right text-muted" style={{ fontSize: 11 }}>
            {topPct === null ? "custom" : `top ${topPct}%`}
          </span>
        </div>
      </div>

      <input
        type="text"
        value={text}
        spellCheck={false}
        aria-label={`${label} range string`}
        aria-invalid={!!error}
        aria-describedby={error ? `range-error-${seat}` : undefined}
        data-testid={`range-text-${seat}`}
        onChange={(e) => onText(e.target.value)}
        className="mt-1.5"
        style={error ? { borderColor: "var(--color-err)" } : undefined}
      />

      <p className="mt-1 min-h-[14px] text-[11px] leading-tight">
        {error ? (
          <span
            className="text-err"
            role="alert"
            id={`range-error-${seat}`}
            data-testid={`range-error-${seat}`}
          >
            {error}
          </span>
        ) : hover !== null ? (
          <span className="num text-muted">
            {CLASS_LABELS[hover]} · {comboCount(hover)} combos ·{" "}
            {Math.round((weights[hover] ?? 0) * 100)}%
          </span>
        ) : (
          <span className="text-dim">
            Click to toggle, drag to paint at the brush weight. Typing here re-reads the grid.
          </span>
        )}
      </p>
    </div>
  );
}
