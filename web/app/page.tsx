"use client";

import dynamic from "next/dynamic";

// The whole workbench holds a wasm SolutionHandle — a pointer into the module's
// linear memory. There is nothing for the server to render, and prerendering it
// would only pull the wasm glue into a Node module graph it has no use for, so the
// component is loaded client-side only.
const Workbench = dynamic(() => import("@/components/Workbench"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center text-muted">
      loading engine…
    </div>
  ),
});

export default function Page() {
  return <Workbench />;
}
