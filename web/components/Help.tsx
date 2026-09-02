"use client";

import { blendToWhite, regretColor } from "@/lib/grid";

/** The eight action colours exactly as `actionColors` hands them to every grid, table and
 *  tree block on the page — the bet ramp darkens with sizing. */
const ACTION_COLORS: [string, string][] = [
  ["#e2705c", "bet or raise · smallest sizing"],
  ["#d1462f", "bet or raise"],
  ["#b02a16", "bet or raise · runout hotness, cold end"],
  ["#8f1a0d", "bet or raise"],
  ["#6e1209", "bet or raise · largest sizing"],
  ["#54ad72", "check"],
  ["#2b7c50", "call · runout hotness, hot end"],
  ["#48566f", "fold"],
];

/** Nine-cell mini grids drawn by the same functions the real 13×13 uses, so the swatch and
 *  the grid can never drift apart. */
const MODE_SWATCHES: { name: string; cells: (string | undefined)[]; line: string }[] = [
  {
    name: "Strategy",
    cells: ["#d1462f", "#54ad72", "#48566f", "#54ad72", "#48566f", "#d1462f", "#48566f", "#d1462f", "#54ad72"],
    line: "color = the action taken most often by that hand class, bar width = the mix.",
  },
  {
    name: "EV",
    cells: [1, 0.55, 0.15, 0.8, 0.35, 1, 0.15, 0.6, 0.9].map((t, i) =>
      blendToWhite(i % 2 === 0 ? "#2b7c50" : "#d1462f", t),
    ),
    line: "color = the highest-EV action, ivory = the actions are near-indifferent.",
  },
  {
    name: "Regret",
    cells: [0, 0.15, 0.35, 0.55, 0.7, 0.85, 1, 0.45, 0.2].map(
      (t) => regretColor(t, 1) ?? undefined,
    ),
    line: "color = big blinds lost against always taking the best action, ivory = none.",
  },
];

export default function Help() {
  return (
    <>
      <article className="bg-panel">
        <div className="bar">
          About this solver
          <span className="meta">5 sections · algorithm, tournaments, browser, grid, files</span>
        </div>

        <div className="max-w-[74ch]" style={{ padding: "clamp(20px,3vw,48px)" }}>
          <h1
            className="uppercase"
            style={{
              font: "900 clamp(28px,3vw,44px)/1 var(--font-sans)",
              letterSpacing: "-.04em",
            }}
          >
            About this solver
          </h1>

          <p className="mt-4 text-[14px] leading-[1.6] text-muted">
            A heads-up no-limit hold&apos;em <strong className="font-bold text-text">postflop</strong>{" "}
            game-theory solver. You give it a board, both players&apos; ranges, an effective stack, a
            starting pot and the bet sizings each player may use; it builds the full game tree for
            that spot and computes an approximate Nash equilibrium for it.
          </p>
          <p className="mt-3 text-[14px] leading-[1.6] text-muted">
            Hand it a payout ladder and every seat&apos;s stack as well and it scores the same spot in{" "}
            <strong className="font-bold text-text">tournament equity</strong> instead of chips. The
            postflop game is still two players; the rest of the table enters through the stack
            vector, never through a multiway tree.
          </p>

          <Section title="The algorithm">
            <p>
              <strong className="font-bold text-text">Discounted CFR</strong> (counterfactual regret
              minimization with the discounting scheme of Brown &amp; Sandholm). Every iteration is
              an <strong className="font-bold text-text">exact vector traversal</strong>: each pass
              walks the whole tree carrying the full vector of live hand combinations for both
              players, so no hand is sampled and no runout is estimated. The strategy reported is
              the average over all iterations, which is the object that converges, not the last
              iterate.
            </p>
            <p>
              Convergence is <strong className="font-bold text-text">measured, not assumed</strong>.
              Exploitability is computed by two full best-response walks, one per player, against
              the current average strategy, and reported in big blinds and as a percent of the starting
              pot. That is the number in the header, and the one plotted while a browser solve runs.
              Under a tournament solve the header says <Code>NashConv</Code> instead, because there
              the number is no longer a bound — see below.
              There are no estimated or placeholder figures anywhere in this UI: every number on
              screen came out of the engine.
            </p>
          </Section>

          <Section title="Tournaments and ICM">
            <p>
              Tick <Code>score this spot with ICM</Code> on the Solve tab, paste the payout ladder
              and every remaining seat&apos;s stack, and each terminal pays{" "}
              <strong className="font-bold text-text">exact Malmuth-Harville tournament equity</strong>{" "}
              instead of chips, rescaled so the numbers stay in chip-sized units (CSTE). Five
              structures ship as presets — winner-take-all, top-heavy, a standard final-table taper,
              flat, and a satellite — and any ladder can be pasted in. Only the shape matters: the
              engine divides by the prize pool, so percentages and dollars solve identically.
            </p>
            <p>
              The honesty cost is paid in the header. Under ICM the two players&apos; equities do not
              sum to a constant — chips move to the frozen field, or drain out of it — so the game is{" "}
              <strong className="font-bold text-text">general-sum</strong> and the sum of two
              best-response values is no longer a bound on anything. What is reported instead is{" "}
              <Code>NashConv</Code>: each player&apos;s unilateral gain from deviating while the other
              stays put, and their sum. Zero NashConv does <em>not</em> certify a minimum EV, adding a
              bet size can lower both players&apos; EV, and playing the equilibrium against a mistake
              can lose equity. Those are properties of the game, not bugs in the solver.
            </p>
            <p>
              The band under the header carries the pairwise{" "}
              <strong className="font-bold text-text">bubble factor</strong> for the two seats in the
              hand — how much equity the hero risks per unit they can win, and therefore the raw
              equity a symmetric all-in needs to break even — and every ICM solve also solves its
              chipEV twin, so the strategy at the node on screen is shown both ways with the
              per-action delta between them. The model is exact Malmuth-Harville and nothing else: no
              blind levels, no future-game simulation, no bounties, equal skill assumed.
            </p>
          </Section>

          <Section title="Browser vs. CLI">
            <p>
              The engine here is the same Rust code as the command line tool, compiled to
              WebAssembly. One difference matters:{" "}
              <strong className="font-bold text-text">in-browser solving is single-threaded.</strong>{" "}
              The native build parallelizes chance-node outcomes with rayon across every core; wasm
              has no thread support in this build, so the browser runs one core. Expect the browser
              to be several times slower on the same spot, and use the <Code>Preflight</Code> readout
              before starting anything large: a failed allocation aborts the wasm module rather
              than returning an error.
            </p>
            <p>
              Inspecting is not affected. Loading a solution rebuilds the tree structure and reads
              the stored strategies; it never re-solves, so even a large saved solve opens quickly.
            </p>
          </Section>

          <Section title="Reading the grid">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                Each of the 169 cells is one starting-hand class. The horizontal bar inside it is
                the acting player&apos;s action mix for that class, weighted by how much of each live
                combo actually reaches this node.
              </li>
              <li>
                Colors are consistent everywhere: folds are cold slate, checks and calls are green
                (calls darker), and bets and raises are red, darker as the sizing grows.
              </li>
              <li>
                A dark, unclickable cell has no live combos here: blocked by the board or absent
                from the range. A faded cell has combos but zero reach on this line.
              </li>
              <li>
                Per-hand EV in the combo panel is zero-sum net big blinds from the start of the
                solve, or CSTE chips on a tournament solve, where it is not zero-sum. A dash means
                the EV is undefined at that node (no opponent mass can face the hand), which is a
                different statement from zero.
              </li>
            </ul>
          </Section>

          <Section title="Files">
            <p>
              Solution files are versioned JSON carrying the config, the per-decision-node
              strategies, the root combo lists and the solve metadata. Anything the CLI&apos;s{" "}
              <Code>solve</Code> command writes opens here, and <Code>Export JSON</Code> writes the
              same format back out. The round trip is exact.
            </p>
          </Section>
        </div>
      </article>

      <aside className="rule-l bg-panel" data-tour="help-legends">
        <h2 className="bar">
          Action colors
          <span className="meta">{ACTION_COLORS.length} inks</span>
        </h2>
        <div className="px-3 py-2">
          {ACTION_COLORS.map(([hex, meaning]) => (
            <div key={hex} className="flex items-center gap-2 py-1">
              <span className="h-1 w-4 shrink-0" style={{ background: hex }} />
              <span className="text-[11px] text-muted">{meaning}</span>
              <span className="num ml-auto text-[10px] text-dim">{hex}</span>
            </div>
          ))}
        </div>

        <h2 className="bar">
          Grid modes
          <span className="meta">{MODE_SWATCHES.length} modes</span>
        </h2>
        <div className="px-3 py-2">
          {MODE_SWATCHES.map((m) => (
            <div key={m.name} className="flex items-start gap-2.5 py-2">
              <span
                className="grid shrink-0 grid-cols-3 gap-px bg-ink p-px"
                style={{ width: 36, height: 36 }}
              >
                {m.cells.map((c, i) => (
                  <span key={i} style={{ background: c }} />
                ))}
              </span>
              <span>
                <span className="label text-text" style={{ color: "var(--color-text)" }}>
                  {m.name}
                </span>
                <span className="mt-1 block text-[11px] leading-[1.5] text-muted">{m.line}</span>
              </span>
            </div>
          ))}
        </div>

        <h2 className="bar">Keys &amp; gestures</h2>
        <div className="px-3 py-2 text-[11px] leading-[1.6] text-muted">
          <p className="py-1">
            <Code>←</Code> <Code>→</Code> step sibling runouts at a chance node.
          </p>
          <p className="py-1">Click a cell to drill into that hand class combo by combo.</p>
          <p className="py-1">Lock a node from the strategy bar, then solve the rest around it.</p>
          <p className="py-1">
            Deep links carry <Code>?node</Code> and <Code>?combo</Code>.
          </p>
        </div>
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2
        className="label border-b-2 border-ink pb-1"
        style={{ fontSize: 11, color: "var(--color-text)" }}
      >
        {title}
      </h2>
      <div className="mt-2 space-y-2 text-[14px] leading-[1.6] text-muted">{children}</div>
    </section>
  );
}

/** Inline code: a mono chip on the recessed paper band. */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="num bg-paper-2 text-text"
      style={{ padding: "1px 4px", border: "1px solid var(--color-line-soft)" }}
    >
      {children}
    </span>
  );
}
