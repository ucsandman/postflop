import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = { themeColor: "#070a11" };

export const metadata: Metadata = {
  metadataBase: new URL("https://postflop-workbench.vercel.app"),
  title: "postflop workbench: solve and inspect HU NLHE spots in your browser",
  description:
    "Browser inspector and solver for heads-up no-limit hold'em postflop spots, running the postflop Rust engine as WebAssembly. Solve small spots on the page or load solutions produced by the CLI.",
  openGraph: {
    title: "postflop workbench",
    description:
      "Solve and inspect heads-up NLHE postflop spots in your browser. The postflop Rust engine, compiled to WebAssembly.",
    url: "https://postflop-workbench.vercel.app/",
    siteName: "postflop",
    images: [{ url: "https://postflop.vercel.app/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "postflop workbench",
    description:
      "Solve and inspect heads-up NLHE postflop spots in your browser. The postflop Rust engine, compiled to WebAssembly.",
    images: ["https://postflop.vercel.app/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
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
