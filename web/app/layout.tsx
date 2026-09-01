import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Both are variable fonts on Google Fonts: no `weight` array — the full 100–900
// axis ships, which is what the 900 posters and the 800 bars need.
const display = Archivo({ subsets: ["latin"], display: "swap", variable: "--font-archivo" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jbmono" });

export const viewport: Viewport = { themeColor: "#E9E5DA" };

export const metadata: Metadata = {
  metadataBase: new URL("https://postflop-workbench.vercel.app"),
  title: "postflop workbench: solve and inspect HU NLHE spots in your browser",
  description:
    "Browser inspector and solver for heads-up no-limit hold'em postflop spots, running the postflop Rust engine as WebAssembly. Solve small spots on the page or load solutions produced by the CLI.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "postflop workbench",
    description:
      "Solve and inspect heads-up NLHE postflop spots in your browser. The postflop Rust engine, compiled to WebAssembly.",
    url: "https://postflop-workbench.vercel.app/",
    siteName: "postflop",
    images: [{ url: "/og.png", width: 2400, height: 1260 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "postflop workbench",
    description:
      "Solve and inspect heads-up NLHE postflop spots in your browser. The postflop Rust engine, compiled to WebAssembly.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} h-full`}>
      <body className="min-h-full">
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("pf-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}',
          }}
        />
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
