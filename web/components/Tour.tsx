"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * One stop on the guided tour. `target` is a CSS selector; when several elements
 * match (the two grid-mode segs live at different breakpoints), the first one
 * with a nonzero box wins. `target: null` renders a centered card with no
 * spotlight: the welcome and any step whose anchor failed to mount.
 */
export interface TourStep {
  id: string;
  title: string;
  body: string;
  target: string | null;
  /** Runs before the step is measured: switch tabs, select a cell, walk the tree. */
  prepare?: () => void;
}

interface Props {
  steps: TourStep[];
  index: number;
  onIndex: (i: number) => void;
  /** `finished` distinguishes "Finish" from "Skip" so the caller can reset the view. */
  onClose: (finished: boolean) => void;
}

type Rect = { top: number; left: number; width: number; height: number };

/** First visible match for the selector, or null. */
function findTarget(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/* Buttons on the knocked-out card. `.btn` hovers to a dark ground, which is the wrong way
   round on stock white, so the card carries its own button style. */
const GHOST: React.CSSProperties = {
  border: "var(--rule) solid var(--color-line)",
  background: "transparent",
  color: "var(--color-paper)",
  font: "600 12.5px/1 var(--font-sans)",
  letterSpacing: ".01em",
  padding: "8px 13px",
  cursor: "pointer",
};

const RING = 4; // gap between the target's box and the spotlight ring
const CARD_W = 380;
const CARD_H = 300; // placement estimate; the card itself scrolls if taller
const GAP = 14; // ring edge -> card

/**
 * The guided tour overlay: a flat spade scrim in four slabs around a spotlight
 * hole, a 2px stock-white rule ringing the target (stock white is this app's
 * selection semantic), and the card knocked out to stock white so it reads as
 * the one sheet printed over the tool. The first overlay in the codebase, so it
 * defines the layer: z-index 100, nothing above it.
 */
export default function Tour({ steps, index, onIndex, onClose }: Props) {
  const step = steps[index];
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const measure = useCallback(() => {
    if (!step.target) {
      setRect(null);
      return;
    }
    const el = findTarget(step.target);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step.target]);

  // prepare() flips tabs and tree state; the anchor only has a box after React
  // commits and the browser lays out, hence the double rAF before measuring.
  // A timer backstop runs the same settle in case rAF never fires. Chrome
  // pauses rAF entirely while the tab is hidden.
  useLayoutEffect(() => {
    step.prepare?.();
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      if (step.target) {
        findTarget(step.target)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      measure();
      nextRef.current?.focus();
    };
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(settle);
    });
    const timer = setTimeout(settle, 150);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    const on = () => measure();
    window.addEventListener("resize", on);
    // capture: the shells scroll internally, not the window
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [measure]);

  // The card is the dialog, so focus starts in it and the app behind it leaves the
  // reading order. `.app` itself cannot be inert: the tour renders inside it.
  useEffect(() => {
    const behind = Array.from(
      document.querySelectorAll<HTMLElement>(".rail, .stage, .statusbar"),
    );
    behind.forEach((el) => el.setAttribute("inert", ""));
    cardRef.current?.focus();
    return () => behind.forEach((el) => el.removeAttribute("inert"));
  }, []);

  // Escape closes; Tab stays inside the card. The app underneath really is
  // inert: the four scrim slabs plus a transparent cover over the spotlight
  // hole swallow every pointer event, so a focus trap is just a cycle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(false);
        return;
      }
      if (e.key !== "Tab" || !cardRef.current) return;
      const focusables = cardRef.current.querySelectorAll<HTMLElement>("button");
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!cardRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  // Clamp the hole INTO the viewport (4px margin) so the ring stays visible even
  // when the target is taller or wider than the screen.
  let hole: Rect | null = null;
  if (rect) {
    const top = Math.max(4, rect.top - RING);
    const left = Math.max(4, rect.left - RING);
    const right = Math.min(vw - 4, rect.left + rect.width + RING);
    const bottom = Math.min(vh - 4, rect.top + rect.height + RING);
    hole = { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  // Card placement: beside the hole on whichever side has room, else below,
  // else above, else centered; always clamped to the viewport.
  const cardW = Math.min(CARD_W, vw - 16);
  let cardStyle: React.CSSProperties;
  if (!hole) {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: cardW };
  } else {
    const spaceRight = vw - (hole.left + hole.width);
    const spaceLeft = hole.left;
    const spaceBelow = vh - (hole.top + hole.height);
    const top = Math.min(Math.max(8, hole.top), Math.max(8, vh - CARD_H));
    if (spaceRight >= cardW + GAP + 8) {
      cardStyle = { top, left: hole.left + hole.width + GAP, width: cardW };
    } else if (spaceLeft >= cardW + GAP + 8) {
      cardStyle = { top, left: hole.left - GAP - cardW, width: cardW };
    } else if (spaceBelow >= CARD_H) {
      cardStyle = {
        top: Math.min(hole.top + hole.height + GAP, Math.max(8, vh - CARD_H)),
        left: Math.min(Math.max(8, hole.left), vw - cardW - 8),
        width: cardW,
      };
    } else {
      cardStyle = {
        top: Math.max(8, hole.top - GAP - CARD_H),
        left: Math.min(Math.max(8, hole.left), vw - cardW - 8),
        width: cardW,
      };
    }
  }

  const scrim = "rgba(23,26,24,.72)"; // plate 1, spade
  const slabs: React.CSSProperties[] = hole
    ? [
        { top: 0, left: 0, width: "100vw", height: hole.top },
        { top: hole.top + hole.height, left: 0, width: "100vw", height: Math.max(0, vh - hole.top - hole.height) },
        { top: hole.top, left: 0, width: hole.left, height: hole.height },
        { top: hole.top, left: hole.left + hole.width, width: Math.max(0, vw - hole.left - hole.width), height: hole.height },
      ]
    : [{ top: 0, left: 0, width: "100vw", height: "100vh" }];

  const last = index === steps.length - 1;

  return (
    <div role="dialog" aria-modal="true" aria-label={`Guided tour, step ${index + 1} of ${steps.length}: ${step.title}`}>
      {slabs.map((s, i) => (
        <div key={i} style={{ position: "fixed", zIndex: 100, background: scrim, ...s }} />
      ))}
      {/* Transparent cover over the hole: the target stays visible but not
          clickable, so a stray click cannot walk the tree, lock a node, or
          unmount the anchor out from under a stale spotlight. */}
      {hole && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            zIndex: 100,
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
          }}
        />
      )}
      {hole && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            zIndex: 101,
            pointerEvents: "none",
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            outline: "2px solid var(--color-live)",
            outlineOffset: 0,
          }}
        />
      )}
      <div
        ref={cardRef}
        data-testid="tour-card"
        /* The dialog role and aria-modal live on the wrapper above, which owns the
           scrim too; the card only needs to be focusable so focus starts inside it. */
        tabIndex={-1}
        style={{
          position: "fixed",
          zIndex: 102,
          background: "var(--color-ink)",
          color: "var(--color-paper)",
          border: "var(--rule) solid var(--color-line)",
          maxHeight: vh - 16,
          overflowY: "auto",
          ...cardStyle,
        }}
      >
        <div
          className="flex items-center gap-2.5"
          style={{
            borderBottom: "var(--rule) solid var(--color-line)",
            padding: "9px 16px 8px",
            font: "600 10px/1.2 var(--font-condensed)",
            letterSpacing: ".15em",
            textTransform: "uppercase",
          }}
        >
          Guided tour
          <span
            className="num"
            style={{ fontSize: 11, letterSpacing: "-.02em", textTransform: "none", color: "var(--color-line)" }}
          >
            {index + 1} / {steps.length}
          </span>
          <button
            data-testid="tour-skip"
            onClick={() => onClose(false)}
            /* The only visible way out of a 16-step modal, so its hit area clears the
                24px minimum without moving the glyph. */
            style={{
              marginLeft: "auto",
              cursor: "pointer",
              background: "transparent",
              border: 0,
              font: "inherit",
              letterSpacing: "inherit",
              color: "var(--color-line)",
              padding: "7px 10px",
              margin: "-7px -10px -7px auto",
            }}
          >
            skip ✕
          </button>
        </div>
        <div className="px-4 py-3.5">
          <h2 style={{ font: "800 21px/1.1 var(--font-sans)", letterSpacing: "-.018em" }}>
            {step.title}
          </h2>
          {/* Printed in the spade plate on the stock: 15.7:1. */}
          <p className="mt-2.5" style={{ font: "400 14px/1.6 var(--font-sans)" }}>
            {step.body}
          </p>
        </div>
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderTop: "var(--rule) solid var(--color-line)" }}
        >
          {index > 0 && (
            <button data-testid="tour-back" onClick={() => onIndex(index - 1)} style={GHOST}>
              Back
            </button>
          )}
          <button
            ref={nextRef}
            data-testid="tour-next"
            onClick={() => (last ? onClose(true) : onIndex(index + 1))}
            className="ml-auto"
            style={{ ...GHOST, background: "var(--color-paper)", color: "var(--color-ink)", fontWeight: 700 }}
          >
            {index === 0 ? "Start the tour →" : last ? "Finish" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}
