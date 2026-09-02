import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found · postflop workbench",
  robots: { index: false, follow: false },
};

/**
 * FOUR PLATES, on the one page a lost visitor sees. Same object as site/404.html:
 * the four-plate ribbon, the registration chip, a mono code line and one club-lit
 * way back. Nothing here is the framework's default.
 */
export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-paper p-6 text-text">
      <main className="w-full max-w-[640px] bg-paper-2" style={{ border: "var(--rule) solid var(--color-line)" }}>
        <div aria-hidden className="flex h-1">
          <i className="flex-1 bg-ink-2" />
          <i className="flex-1" style={{ backgroundColor: "var(--color-card-h)" }} />
          <i className="flex-1" style={{ backgroundColor: "var(--color-card-d)" }} />
          <i className="flex-1" style={{ backgroundColor: "var(--color-card-c)" }} />
        </div>
        <div style={{ padding: "clamp(28px,5vw,52px)" }}>
          <span aria-hidden className="mb-[22px] grid h-[22px] w-[22px] grid-cols-2 grid-rows-2">
            <i style={{ backgroundColor: "var(--color-ink-2)" }} />
            <i style={{ backgroundColor: "var(--color-card-h)" }} />
            <i style={{ backgroundColor: "var(--color-card-d)" }} />
            <i style={{ backgroundColor: "var(--color-card-c)" }} />
          </span>
          <p className="num flex items-center gap-2.5 text-dim">
            <b className="bg-ink px-[7px] py-[3px] font-medium text-paper">404</b> dead card
          </p>
          <h1
            className="mt-4 mb-3"
            style={{
              font: "800 clamp(2rem,6vw,3.2rem)/1.03 var(--font-sans)",
              letterSpacing: "-.018em",
              textWrap: "balance",
            }}
          >
            This page is not in the deck.
          </h1>
          <p className="text-[16px] text-dim">
            The address may have changed, or it never existed.
          </p>
          <Link
            href="/"
            className="mt-7 inline-block bg-accent px-[22px] py-[14px] text-accent-ink hover:bg-ink hover:text-paper"
            style={{ font: "700 13px/1 var(--font-sans)" }}
          >
            Back to the workbench
          </Link>
        </div>
      </main>
    </div>
  );
}
