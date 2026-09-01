// Copies the wasm-pack `--target web` output into the Next app.
//
// Two destinations, on purpose:
//   vendor/solver-wasm/  glue + types, imported by the bundler (typed, tree-shaken)
//   public/wasm/         glue + .wasm binary, served over HTTP so the module worker
//                        (public/wasm/solve-worker.js) and `init()` can fetch them
//
// Both are gitignored build output. Run `wasm-pack build wasm --target web --out-dir pkg`
// in the repo root first; this script is wired to npm predev/prebuild.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(web, "..", "wasm", "pkg");

if (!existsSync(join(pkg, "solver_wasm_bg.wasm"))) {
  console.error(
    `[sync-wasm] missing ${pkg}\n` +
      `  build it first:  wasm-pack build wasm --target web --out-dir pkg`,
  );
  process.exit(1);
}

const jobs = [
  ["solver_wasm.js", "vendor/solver-wasm"],
  ["solver_wasm.d.ts", "vendor/solver-wasm"],
  ["solver_wasm.js", "public/wasm"],
  ["solver_wasm_bg.wasm", "public/wasm"],
];

for (const [file, dest] of jobs) {
  mkdirSync(join(web, dest), { recursive: true });
  copyFileSync(join(pkg, file), join(web, dest, file));
}

// The glue's fallback path is `new URL('solver_wasm_bg.wasm', import.meta.url)`.
// Turbopack tries to *resolve* that asset at build time even though `lib/wasm.ts`
// always passes an explicit `module_or_path`, and the binary is not next to the
// bundled copy. Point the fallback at the public URL instead of shipping a second
// 600 KB copy into the bundle just to satisfy the resolver.
const GLUE_DEFAULT = "new URL('solver_wasm_bg.wasm', import.meta.url)";
const vendored = join(web, "vendor/solver-wasm/solver_wasm.js");
const glue = readFileSync(vendored, "utf8");
if (!glue.includes(GLUE_DEFAULT)) {
  console.error(`[sync-wasm] wasm-pack glue changed shape: could not find ${GLUE_DEFAULT}`);
  process.exit(1);
}
writeFileSync(vendored, glue.replace(GLUE_DEFAULT, `"${"/wasm/solver_wasm_bg.wasm"}"`));

// Sample solutions for the one-click fixture buttons.
for (const f of ["fixture-turn.json", "fixture-river.json"]) {
  const from = join(web, "..", f);
  if (existsSync(from)) copyFileSync(from, join(web, "public", "fixtures", f));
  else console.warn(`[sync-wasm] fixture not found, skipping: ${from}`);
}

console.log(`[sync-wasm] ok (${jobs.length} wasm files + fixtures)`);
