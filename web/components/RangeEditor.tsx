"use client";

// Interactive 13x13 range editor. One instance per seat; the Solve tab puts the two
// side by side (they are narrow enough to read at 13 columns and comparing OOP against
// IP is the whole point of a postflop spot).
//
// The form still stores a range STRING, exactly as before — that is what goes into the
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
import { loadWasm } from "@/lib/wasm";

/** Range fill, matching the Inspector's reach-density blue. */
const FILL = "#3f6fa8";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** wasm + the 1326 -> 169 class map, loaded once for the whole page. */
let engine: Promise<{ expand: (range: string) => number[]; map: Int16Array }> | null = null;
const getEngine = () =>
  (engine ??= loadWasm().then((wasm) => ({
    expand: (range: string) => (JSON.parse(wasm.parse_range(range)) as { weights: number[] }).weights,
    map: classMap(JSON.parse(wasm.combo_labels()) as string[]),
  })));

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
  /** null once a hand edit diverges from the slider — the slider then reads "custom". */
  const [topPct, setTopPct] = useState<number | null>(null);
  const [brush, setBrush] = useState(100);
  const [hover, setHover] = useState<number | null>(null);

  /** The last string this editor handed the form, so an echo back does not re-parse. */
  const emitted = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Weight painted for the duration of one drag; null when not painting. */
  const painting = useRef<number | null>(null);
  /** Where the pointer was on the previous move, so a fast drag skips no cells. */
  const last = useRef<{ x: number; y: number } | null>(null);
  /** Live weights during a drag — state lags a fast pointer, a ref does not. */
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

  /** Typed text is the source of truth until the next grid edit — parse it, don't rewrite it. */
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

  const startPaint = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const index = Number(e.currentTarget.dataset.index);
    const target = brush / 100;
    // Clicking a cell that already holds the brush weight clears it; everything else,
    // including every cell the drag then crosses, is set to the brush.
    const value = Math.abs(weights[index] - target) < 1e-9 ? 0 : target;
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
    <div className="rounded border border-line-soft p-2" data-testid={`range-editor-${seat}`}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="label text-accent-dim">{label} range</span>
        <span className="num text-[11px] text-muted" data-testid={`range-count-${seat}`}>
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
        className={`grid touch-none select-none gap-px bg-line-soft p-px ${ready ? "" : "opacity-40"}`}
        style={{ gridTemplateColumns: "repeat(13, minmax(0, 1fr))" }}
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
              title={`${cell} — ${comboCount(index)} combos · ${Math.round(w * 100)}%`}
              onPointerDown={startPaint}
              onPointerEnter={() => setHover(index)}
              className="relative aspect-square cursor-pointer overflow-hidden bg-[#0d121a] text-[8px] hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-[#5b6b86]"
            >
              {/* Partial weights read as a part-filled cell, the same stacked-bar language
                  the Inspector uses for action frequencies. */}
              <span
                className="absolute inset-x-0 bottom-0"
                style={{ height: `${w * 100}%`, background: FILL }}
              />
              <span className="num relative z-[1] flex h-full w-full items-center justify-center font-semibold text-white/95 [text-shadow:0_1px_2px_rgba(0,0,0,.75)]">
                {cell}
              </span>
            </button>
          );
        })}
      </div>

      {/* minmax(0,...) or the range inputs' intrinsic width blows the track out. */}
      <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <span className="label">brush</span>
        <div className="flex items-center gap-1.5">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setBrush(p)}
              data-testid={`brush-${p}-${seat}`}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                brush === p
                  ? "border-accent bg-accent font-semibold text-ink"
                  : "border-line bg-raised text-muted hover:border-accent-dim"
              }`}
            >
              {p}%
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={brush}
            aria-label={`${label} brush weight`}
            data-testid={`brush-slider-${seat}`}
            onChange={(e) => setBrush(Number(e.target.value))}
            className="min-w-0 flex-1 accent-[#e0aa4e]"
          />
          <span className="num w-8 text-right text-[11px] text-muted">{brush}%</span>
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
            className="min-w-0 flex-1 accent-[#e0aa4e]"
          />
          <span className="num w-14 text-right text-[11px] text-muted">
            {topPct === null ? "custom" : `top ${topPct}%`}
          </span>
        </div>
      </div>

      <input
        type="text"
        value={text}
        spellCheck={false}
        aria-label={`${label} range string`}
        data-testid={`range-text-${seat}`}
        onChange={(e) => onText(e.target.value)}
        className="mt-1.5"
      />

      <p className="mt-1 min-h-[14px] text-[10px] leading-tight">
        {error ? (
          <span className="text-card-h" data-testid={`range-error-${seat}`}>
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
