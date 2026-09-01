"use client";

export default function Help() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="panel p-6 leading-relaxed">
        <h1 className="mb-3 text-lg font-semibold">About this solver</h1>

        <p className="mb-4 text-muted">
          A heads-up no-limit hold&apos;em <strong className="text-text">postflop</strong> game-theory
          solver. You give it a board, both players&apos; ranges, an effective stack, a starting pot
          and the bet sizings each player may use; it builds the full game tree for that spot and
          computes an approximate Nash equilibrium for it.
        </p>

        <Section title="The algorithm">
          <p>
            <strong className="text-text">Discounted CFR</strong> (counterfactual regret minimisation
            with the discounting scheme of Brown &amp; Sandholm). Every iteration is an{" "}
            <strong className="text-text">exact vector traversal</strong>: each pass walks the whole
            tree carrying the full vector of live hand combinations for both players, so no hand is
            sampled and no runout is estimated. The strategy reported is the average over all
            iterations, which is the object that converges — not the last iterate.
          </p>
          <p>
            Convergence is <strong className="text-text">measured, not assumed</strong>. Exploitability
            is computed by two full best-response walks — one per player — against the current average
            strategy, and reported in chips and as a percent of the starting pot. That is the number
            in the header, and the one plotted while a browser solve runs. There are no estimated or
            placeholder figures anywhere in this UI: every number on screen came out of the engine.
          </p>
        </Section>

        <Section title="Browser vs. CLI">
          <p>
            The engine here is the same Rust code as the command line tool, compiled to WebAssembly.
            One difference matters:{" "}
            <strong className="text-text">in-browser solving is single-threaded.</strong> The native
            build parallelises chance-node outcomes with rayon across every core; wasm has no thread
            support in this build, so the browser runs one core. Expect the browser to be several
            times slower on the same spot, and use the{" "}
            <span className="num text-text">Preflight</span> readout before starting anything large —
            a failed allocation aborts the wasm module rather than returning an error.
          </p>
          <p>
            Inspecting is not affected. Loading a solution rebuilds the tree structure and reads the
            stored strategies; it never re-solves, so even a large saved solve opens quickly.
          </p>
        </Section>

        <Section title="Reading the grid">
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Each of the 169 cells is one starting-hand class. The horizontal bar inside it is the
              acting player&apos;s action mix for that class, weighted by how much of each live combo
              actually reaches this node.
            </li>
            <li>
              Colours are consistent everywhere: folds are cold slate, checks and calls are green
              (calls darker), and bets and raises are red — darker as the sizing grows.
            </li>
            <li>
              A dark, unclickable cell has no live combos here — blocked by the board or absent from
              the range. A faded cell has combos but zero reach on this line.
            </li>
            <li>
              Per-hand EV in the combo panel is zero-sum net chips from the start of the solve.
              A dash means the EV is undefined at that node (no opponent mass can face the hand), which
              is a different statement from zero.
            </li>
          </ul>
        </Section>

        <Section title="Files">
          <p>
            Solution files are versioned JSON carrying the config, the per-decision-node strategies,
            the root combo lists and the solve metadata. Anything the CLI&apos;s{" "}
            <span className="num text-text">solve</span> command writes opens here, and{" "}
            <span className="num text-text">Export JSON</span> writes the same format back out — the
            round trip is exact.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="label mb-1.5 text-accent-dim">{title}</h2>
      <div className="space-y-2 text-muted">{children}</div>
    </section>
  );
}
