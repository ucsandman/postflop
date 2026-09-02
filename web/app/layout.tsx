import type { Metadata, Viewport } from "next";
import { Azeret_Mono, Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

// FOUR PLATES. Barlow is the signage, Azeret is the instrument readout, and
// Barlow Condensed is confined to labels so caps read as machine annotation.
// Variable names match the faces: display, condensed-face, mono-face.
const display = Barlow({
  subsets: ["latin"],
  display: "swap",
  // No 500 anywhere: every var(--font-sans) use is 400, 600, 700 or 800.
  weight: ["400", "600", "700", "800"],
  variable: "--font-display",
});
const condensed = Barlow_Condensed({
  subsets: ["latin"],
  display: "swap",
  // Condensed is labels only, and every one of them is 600 or 700.
  weight: ["600", "700"],
  variable: "--font-condensed-face",
});
const mono = Azeret_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "700"],
  variable: "--font-mono-face",
});

export const viewport: Viewport = { themeColor: "#171A18" };

export const metadata: Metadata = {
  metadataBase: new URL("https://postflop-workbench.vercel.app"),
  title: "postflop workbench: solve and inspect HU NLHE spots, in chips or ICM",
  description:
    "Browser inspector and solver for heads-up no-limit hold'em postflop spots, running the postflop Rust engine as WebAssembly. Solve for chipEV, or give it a payout ladder and per-seat stacks and solve the same spot in tournament equity with the two answers side by side.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "postflop workbench",
    description:
      "Solve and inspect heads-up NLHE postflop spots in your browser, for chipEV or under tournament ICM. The postflop Rust engine, compiled to WebAssembly.",
    url: "https://postflop-workbench.vercel.app/",
    siteName: "postflop",
    images: [
      {
        url: "/og.png",
        width: 2400,
        height: 1260,
        alt: "postflop workbench: the four-plate mark over a 13 by 13 strategy grid, the check band under its 45 degree hatch, and the measured exploitability figure.",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "postflop workbench",
    description:
      "Solve and inspect heads-up NLHE postflop spots in your browser, for chipEV or under tournament ICM. The postflop Rust engine, compiled to WebAssembly.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${condensed.variable} ${mono.variable} h-full`}
    >
      <body className="min-h-full">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };",
          }}
        />
        <script defer src="/_vercel/insights/script.js" />
      </body>
    </html>
  );
}
