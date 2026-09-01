// Deploys the static export to the postflop-workbench Vercel project.
//
// `next build` wipes out/, taking the Vercel project link with it; without
// relinking, a deploy from out/ auto-creates a brand-new project named "out".
// This script rebuilds, restores the link + framework override, and deploys.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(web, "out");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit", shell: true });

run("npm run build", web);

// Project settings say "nextjs"; the export is plain files, so override.
writeFileSync(join(out, "vercel.json"), JSON.stringify({ framework: null }) + "\n");
mkdirSync(join(out, ".vercel"), { recursive: true });
writeFileSync(
  join(out, ".vercel", "project.json"),
  JSON.stringify({
    projectId: "prj_4PmHlBxsMl6i3QcQuDgDqEAUenXy",
    orgId: "team_RXkKPVQRukJzBSNy6v9hsqWk",
    projectName: "postflop-workbench",
  }) + "\n",
);

run("vercel deploy --prod --yes", out);
