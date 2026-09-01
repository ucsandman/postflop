"use client";

import { SUIT_CLASS, SUIT_GLYPH } from "@/lib/grid";

/** One card, e.g. `"Qs"` -> `Q♠` in the suit colour. */
export default function Card({ card, className = "" }: { card: string; className?: string }) {
  const rank = card[0].toUpperCase();
  const suit = card[1]?.toLowerCase() ?? "s";
  return (
    <span className={`num ${SUIT_CLASS[suit] ?? "text-text"} ${className}`}>
      {rank}
      {SUIT_GLYPH[suit] ?? suit}
    </span>
  );
}

export function Cards({ cards, className = "" }: { cards: string[]; className?: string }) {
  return (
    <span className={`inline-flex gap-1 ${className}`}>
      {cards.map((c, i) => (
        <Card key={`${c}-${i}`} card={c} />
      ))}
    </span>
  );
}

/** `"4cAc"` -> two cards, high rank first. */
export function ComboCards({ cards, className = "" }: { cards: string; className?: string }) {
  const a = cards.slice(0, 2);
  const b = cards.slice(2, 4);
  const order = "AKQJT98765432";
  const pair = order.indexOf(a[0].toUpperCase()) <= order.indexOf(b[0].toUpperCase()) ? [a, b] : [b, a];
  return <Cards cards={pair} className={className} />;
}
