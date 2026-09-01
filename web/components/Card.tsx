"use client";

import { SUIT_CLASS, SUIT_GLYPH } from "@/lib/grid";

/**
 * One card. `glyph` (default) is the dense inline form, e.g. `"Qs"` -> `Q♠` in the
 * suit colour. `stock` renders a small paper playing card — rank over suit inside a
 * 2px ink frame — sized by `size` (the font size in px; the card is 2.2em × 3em).
 */
export default function Card({
  card,
  className = "",
  variant = "glyph",
  size,
}: {
  card: string;
  className?: string;
  variant?: "glyph" | "stock";
  size?: number;
}) {
  const rank = card[0].toUpperCase();
  const suit = card[1]?.toLowerCase() ?? "s";
  if (variant === "stock") {
    return (
      <span
        className={`cardstock ${SUIT_CLASS[suit] ?? "text-card-s"} ${className}`}
        style={size ? { fontSize: size } : undefined}
      >
        <b>{rank}</b>
        <i>{SUIT_GLYPH[suit] ?? suit}</i>
      </span>
    );
  }
  return (
    <span className={`num ${SUIT_CLASS[suit] ?? "text-text"} ${className}`}>
      {rank}
      {SUIT_GLYPH[suit] ?? suit}
    </span>
  );
}

export function Cards({
  cards,
  className = "",
  variant,
  size,
}: {
  cards: string[];
  className?: string;
  variant?: "glyph" | "stock";
  size?: number;
}) {
  return (
    <span className={`inline-flex gap-1 ${className}`}>
      {cards.map((c, i) => (
        <Card key={`${c}-${i}`} card={c} variant={variant} size={size} />
      ))}
    </span>
  );
}

/** `"4cAc"` -> two cards, high rank first. */
export function ComboCards({
  cards,
  className = "",
  variant,
  size,
}: {
  cards: string;
  className?: string;
  variant?: "glyph" | "stock";
  size?: number;
}) {
  const a = cards.slice(0, 2);
  const b = cards.slice(2, 4);
  const order = "AKQJT98765432";
  const pair = order.indexOf(a[0].toUpperCase()) <= order.indexOf(b[0].toUpperCase()) ? [a, b] : [b, a];
  return <Cards cards={pair} className={className} variant={variant} size={size} />;
}
