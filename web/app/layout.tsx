import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solver — HU NLHE postflop workbench",
  description:
    "Browser inspector and solver for heads-up no-limit hold'em postflop solutions, running the engine as WebAssembly.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
