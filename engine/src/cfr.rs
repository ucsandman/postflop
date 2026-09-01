//! Vector-form Discounted CFR (Brown & Sandholm, AAAI 2019) with alternating updates.
//!
//! Full traversal of every live combo on every iteration — no external sampling, no
//! outcome sampling, no abstraction. One iteration walks the tree twice: once updating
//! player 0's regrets and strategy sums against player 1's current strategy, then once
//! the other way round.
//!
//! Storage is two flat arrays (cumulative regret, cumulative strategy) with one
//! precomputed offset per decision node and `num_actions * combo_count` entries each,
//! laid out action-major (`[a * combos + i]`). Working vectors come from a bump arena
//! that stops growing after the first iteration, so the steady-state traversal does not
//! allocate.
//!
//! Those two arrays are `f32` by default and can optionally be `i16`-compressed — see
//! [`StorageMode`] and [`Solver::new_with_storage`]. Compression is a codec at the
//! region read/write boundary only; every arithmetic step below still runs in `f32`.
//!
//! Convergence is measured by exploitability from [`crate::br`], never by regret
//! magnitude.
//!
//! # Parallelism (rayon), and why it is bit-deterministic
//!
//! Gated behind the default-on `parallel` feature. Building with
//! `--no-default-features` drops rayon entirely and leaves the sequential chance branch
//! as the only path — required for `wasm32-unknown-unknown`, where rayon cannot spawn
//! threads. Because the parallel branch is bit-identical to the sequential one (below),
//! turning the feature off changes speed and nothing else.
//!
//! The traversal forks at **chance nodes** — the 49 turn cards, the 48 river cards —
//! and only at the *outermost* one on any path ([`PAR_MIN_OUTCOMES`] outcomes or more),
//! which on a flop tree is a turn node with 49 fat, well-balanced subtrees. Inner
//! per-combo loops stay flat sequential `f32` loops so they keep vectorizing; nothing
//! below the fork is parallel.
//!
//! Two properties make the result **bit-identical to the sequential walk**, and hence
//! identical for any thread count:
//!
//! 1. **Parallel map, sequential reduce.** Each outcome writes its counterfactual value
//!    vector into its own buffer. The expansion back into the parent's slots
//!    (`out[parent_of_child[k]] += child[k]`) then runs on the main thread in ascending
//!    outcome order — exactly the order the sequential loop used. Float addition is not
//!    associative, so this fixed order is the whole game.
//! 2. **Disjoint storage writes.** See [`Store`]. No atomics, no locks, no reduction
//!    over regrets.
//!
//! The best-response walk in [`crate::br`] is still sequential; with a coarse
//! `report_every` it is a small share of a solve.

use std::slice;

#[cfg(feature = "parallel")]
use rayon::prelude::*;

use crate::br::{self, ExploitReport, StrategyProfile};
use crate::config::SolveConfig;
use crate::game::{Game, NodeInfo};

/// Fork a chance node across threads only when it has at least this many outcomes.
///
/// Real runouts have 48 or 49; toy games (and any future 2- or 3-way chance node) stay
/// on the sequential path, where rayon's fork overhead would swamp the subtree.
pub const PAR_MIN_OUTCOMES: usize = 8;

/// Discounting schedule. Defaults are the DCFR paper's recommended `1.5 / 0 / 2`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DcfrParams {
    /// Exponent on the discount applied to **positive** cumulative regret.
    pub alpha: f64,
    /// Exponent on the discount applied to **negative** cumulative regret.
    pub beta: f64,
    /// Exponent on the discount applied to the cumulative strategy.
    pub gamma: f64,
    /// CFR+/DCFR+ style flag: clamp cumulative regret at zero right after each update,
    /// so a negative regret never has to be climbed back out of. Off by default.
    pub floor_regrets_at_zero: bool,
}

impl Default for DcfrParams {
    fn default() -> Self {
        DcfrParams { alpha: 1.5, beta: 0.0, gamma: 2.0, floor_regrets_at_zero: false }
    }
}

impl DcfrParams {
    /// Reads `alpha`/`beta`/`gamma` off a [`SolveConfig`]. The regret floor is not a
    /// config field and stays off.
    pub fn from_config(cfg: &SolveConfig) -> Self {
        DcfrParams {
            alpha: cfg.alpha,
            beta: cfg.beta,
            gamma: cfg.gamma,
            floor_regrets_at_zero: false,
        }
    }
}

/// Bump arena of `f32` working vectors, indexed rather than borrowed so that a
/// recursive traversal can hold several regions at once without fighting the borrow
/// checker. `top` is saved and restored around each recursive call.
pub(crate) struct Scratch {
    pub buf: Vec<f32>,
    pub top: usize,
}

impl Scratch {
    pub(crate) fn new() -> Self {
        Scratch { buf: Vec::new(), top: 0 }
    }

    /// Reserves `n` slots and returns their base index. Contents are unspecified.
    /// Only grows the backing `Vec` on the first traversal that reaches a given depth.
    #[inline]
    pub(crate) fn alloc(&mut self, n: usize) -> usize {
        let base = self.top;
        self.top += n;
        if self.buf.len() < self.top {
            self.buf.resize(self.top, 0.0);
        }
        base
    }

    #[inline]
    pub(crate) fn zero(&mut self, base: usize, n: usize) {
        self.buf[base..base + n].fill(0.0);
    }
}

/// Splits one arena into a disjoint read slice and write slice. Panics if the ranges
/// overlap.
pub(crate) fn read_write(
    buf: &mut [f32],
    r: usize,
    rn: usize,
    w: usize,
    wn: usize,
) -> (&[f32], &mut [f32]) {
    if r + rn <= w {
        let (lo, hi) = buf.split_at_mut(w);
        let lo: &[f32] = lo;
        (&lo[r..r + rn], &mut hi[..wn])
    } else {
        assert!(w + wn <= r, "read and write regions overlap");
        let (lo, hi) = buf.split_at_mut(r);
        let hi: &[f32] = hi;
        (&hi[..rn], &mut lo[w..w + wn])
    }
}

/// How the solver keeps its two big per-node arrays.
///
/// [`StorageMode::F32`] is the reference and the default: one `f32` per entry.
///
/// [`StorageMode::I16`] halves that with the standard TexasSolver-style scheme — one
/// `i16` per entry plus **one `f32` scale per decision-node region per array**, where
/// the scale is `max |v|` over the region and is refreshed every time the region is
/// rewritten:
///
/// ```text
/// encode: q = round(v / scale * 32767)      decode: v = q * scale / 32767
/// ```
///
/// so the worst-case absolute error on any entry is half a quantum, `scale / 65534`.
///
/// Compression is a **storage codec at region read/write boundaries, not a change to
/// the math**: regret matching, DCFR discounting and the gamma-weighted strategy
/// accumulation all still run in `f32` on decoded values. A region is decoded into an
/// `f32` scratch buffer, updated by exactly the same flat loops the `f32` mode runs on
/// its slices, and encoded back.
///
/// Everything else is unchanged: results are still bit-identical across thread counts
/// (the codec is elementwise and deterministic, and the disjointness argument in
/// [`Store`] is untouched), and both the `parallel` and sequential builds support it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StorageMode {
    /// One `f32` per entry. 4 bytes each.
    #[default]
    F32,
    /// One `i16` per entry plus one `f32` scale per node per array. 2 bytes each.
    I16,
}

/// Largest magnitude an encoded entry can take. `i16::MAX`, so `-Q_MAX` is
/// representable too and the codec is symmetric about zero.
const Q_MAX: f32 = 32767.0;

/// Quantizes `src` into `dst`, returning the region scale (`max |src|`, or 0 for an
/// all-zero region — which decodes back to all zeros).
#[inline]
fn encode(src: &[f32], dst: &mut [i16]) -> f32 {
    debug_assert_eq!(src.len(), dst.len());
    let mut scale = 0.0f32;
    for &v in src {
        let a = v.abs();
        if a > scale {
            scale = a;
        }
    }
    if scale == 0.0 {
        dst.fill(0);
        return 0.0;
    }
    let inv = Q_MAX / scale;
    for (d, &v) in dst.iter_mut().zip(src) {
        // `as i16` saturates, so a 1-ulp overshoot on the extreme entry cannot wrap.
        *d = (v * inv).round() as i16;
    }
    scale
}

/// Inverse of [`encode`].
#[inline]
fn decode(src: &[i16], scale: f32, dst: &mut [f32]) {
    debug_assert_eq!(src.len(), dst.len());
    let q = scale / Q_MAX;
    for (d, &v) in dst.iter_mut().zip(src) {
        *d = v as f32 * q;
    }
}

/// One of the solver's two per-node arrays, in whichever [`StorageMode`] was chosen.
enum Array {
    F32(Vec<f32>),
    /// `data` is the flat quantized payload with the same offsets/sizes as the `f32`
    /// layout; `scales` is indexed by **node id** (one scale per decision-node region,
    /// zero for non-decision nodes, which own no region).
    I16 { data: Vec<i16>, scales: Vec<f32> },
}

impl Array {
    fn new(mode: StorageMode, entries: usize, nodes: usize) -> Array {
        match mode {
            StorageMode::F32 => Array::F32(vec![0.0; entries]),
            StorageMode::I16 => Array::I16 { data: vec![0; entries], scales: vec![0.0; nodes] },
        }
    }

    fn entries(&self) -> usize {
        match self {
            Array::F32(v) => v.len(),
            Array::I16 { data, .. } => data.len(),
        }
    }

    /// Heap bytes actually held, scale table included.
    fn bytes(&self) -> usize {
        match self {
            Array::F32(v) => v.len() * 4,
            Array::I16 { data, scales } => data.len() * 2 + scales.len() * 4,
        }
    }

    fn ptr(&mut self) -> ArrayPtr {
        match self {
            Array::F32(v) => ArrayPtr::F32(v.as_mut_ptr()),
            Array::I16 { data, scales } => {
                ArrayPtr::I16 { data: data.as_mut_ptr(), scales: scales.as_mut_ptr() }
            }
        }
    }

    /// Reads `node`'s region starting at `off` into `out` (whose length is the region
    /// size).
    fn decode_into(&self, node: u32, off: usize, out: &mut [f32]) {
        let n = out.len();
        match self {
            Array::F32(v) => out.copy_from_slice(&v[off..off + n]),
            Array::I16 { data, scales } => {
                decode(&data[off..off + n], scales[node as usize], out)
            }
        }
    }

    /// Multiplies every stored value by `f > 0`.
    ///
    /// Compressed, this only touches the scale table: a uniform positive factor moves
    /// every region's max-abs by exactly `f`, so `scale * f` is still that region's
    /// max-abs and the payload is already correct. Exact, and no requantization error.
    fn scale_all(&mut self, f: f32) {
        match self {
            Array::F32(v) => {
                for x in v.iter_mut() {
                    *x *= f;
                }
            }
            Array::I16 { scales, .. } => {
                for s in scales.iter_mut() {
                    *s *= f;
                }
            }
        }
    }

    /// Writes `src` back into `node`'s region starting at `off`, refreshing the scale.
    fn encode_from(&mut self, node: u32, off: usize, src: &[f32]) {
        let n = src.len();
        match self {
            Array::F32(v) => v[off..off + n].copy_from_slice(src),
            Array::I16 { data, scales } => {
                scales[node as usize] = encode(src, &mut data[off..off + n]);
            }
        }
    }
}

/// Raw-pointer form of an [`Array`], carried by [`Store`] across parallel tasks.
#[derive(Clone, Copy)]
enum ArrayPtr {
    F32(*mut f32),
    I16 { data: *mut i16, scales: *mut f32 },
}

impl ArrayPtr {
    /// The region itself in `f32` mode — the zero-copy fast path. `None` when
    /// compressed, in which case the caller must go through [`ArrayPtr::load`] and
    /// [`ArrayPtr::store`].
    ///
    /// # Safety
    /// Same contract as [`Store::regrets`]: `off..off + n` must be one node's own
    /// region and no other live reference may cover it.
    #[inline]
    unsafe fn direct(&self, off: usize, n: usize) -> Option<&'static mut [f32]> {
        match *self {
            ArrayPtr::F32(p) => Some(slice::from_raw_parts_mut(p.add(off), n)),
            ArrayPtr::I16 { .. } => None,
        }
    }

    /// Decodes (or copies) `node`'s region into `out`.
    ///
    /// # Safety
    /// As [`ArrayPtr::direct`].
    #[inline]
    unsafe fn load(&self, node: u32, off: usize, out: &mut [f32]) {
        let n = out.len();
        match *self {
            ArrayPtr::F32(p) => out.copy_from_slice(slice::from_raw_parts(p.add(off), n)),
            ArrayPtr::I16 { data, scales } => decode(
                slice::from_raw_parts(data.add(off), n),
                *scales.add(node as usize),
                out,
            ),
        }
    }

    /// Encodes (or copies) `src` back into `node`'s region, refreshing its scale.
    ///
    /// # Safety
    /// As [`ArrayPtr::direct`].
    #[inline]
    unsafe fn store(&self, node: u32, off: usize, src: &[f32]) {
        let n = src.len();
        match *self {
            ArrayPtr::F32(p) => {
                slice::from_raw_parts_mut(p.add(off), n).copy_from_slice(src);
            }
            ArrayPtr::I16 { data, scales } => {
                *scales.add(node as usize) =
                    encode(src, slice::from_raw_parts_mut(data.add(off), n));
            }
        }
    }
}

/// Shared handle on the solver's two per-node storage arrays, handed by value to
/// parallel subtree tasks.
///
/// # Why raw pointers, and why this is sound
///
/// A `&mut [f32]` cannot be split across chance outcomes with `split_at_mut` — the
/// regions a subtree touches are scattered by node id, not contiguous — and a
/// `Mutex`/`RefCell` per node in the hot path would cost more than the parallelism buys.
/// So the two arrays travel as raw pointers and every access materializes a `&mut [f32]`
/// covering **one decision node's region only** (`offsets[node] .. + sizes[node]`).
///
/// Those per-node regions never alias across concurrent tasks:
///
/// * The solver lays storage out with one disjoint `[off, off + size)` block per
///   decision node (see [`Solver::new`]), so two distinct nodes never share a slot.
/// * Tasks are forked one per outcome of a single chance node, and the tree builds a
///   **distinct subtree per chance outcome** — no node is reachable from two outcomes of
///   the same chance node. So task `k` writes only nodes in subtree `k`, and the subtrees
///   are node-disjoint.
/// * Alternating updates mean a half-iteration writes only the *traversing* player's
///   nodes, which shrinks the write set further but is not needed for the argument.
/// * The parent's own frames (`self.scratch`, the reduction buffer) are never handed to a
///   task; each task allocates its own [`Scratch`].
///
/// Hence at most one live `&mut` exists for any byte at any time, which is what the
/// aliasing rules actually require. Widening the fork beyond one chance node's outcomes
/// — e.g. forking two chance nodes at once, or reusing a `Store` across a decision edge
/// — would break the second bullet and is not done anywhere.
/// Under [`StorageMode::I16`] the same argument covers the per-node scale tables: a
/// region's scale lives at `scales[node]`, so two distinct nodes never share a scale
/// slot either, and a task writes only the scales of the nodes it owns.
#[derive(Clone, Copy)]
pub(crate) struct Store {
    regrets: ArrayPtr,
    strat: ArrayPtr,
    len: usize,
}

// SAFETY: `Store` is only ever shared under the disjointness argument documented above.
unsafe impl Send for Store {}
unsafe impl Sync for Store {}

impl Store {
    fn new(regrets: &mut Array, strat: &mut Array) -> Store {
        debug_assert_eq!(regrets.entries(), strat.entries());
        let len = regrets.entries();
        Store { regrets: regrets.ptr(), strat: strat.ptr(), len }
    }

    /// Cumulative regret for one node's region, borrowed in place. `None` when the
    /// array is compressed.
    ///
    /// # Safety
    /// `off..off + n` must be that node's own region, and no other live reference may
    /// cover it. See the type docs for why concurrent tasks satisfy this.
    #[inline]
    unsafe fn regrets(&self, off: usize, n: usize) -> Option<&'static mut [f32]> {
        debug_assert!(off + n <= self.len);
        self.regrets.direct(off, n)
    }

    /// Cumulative strategy for one node's region. Same contract as [`Store::regrets`].
    #[inline]
    unsafe fn strat(&self, off: usize, n: usize) -> Option<&'static mut [f32]> {
        debug_assert!(off + n <= self.len);
        self.strat.direct(off, n)
    }
}

/// Fills `out` (action-major, `n_act * n_combo`) with regret matching over `regrets`:
/// `sigma(a) ∝ max(R(a), 0)`, uniform when no action has positive regret.
pub(crate) fn regret_matching(regrets: &[f32], n_act: usize, n_combo: usize, out: &mut [f32]) {
    let uniform = 1.0 / n_act as f32;
    for i in 0..n_combo {
        let mut sum = 0.0f32;
        for a in 0..n_act {
            let r = regrets[a * n_combo + i];
            if r > 0.0 {
                sum += r;
            }
        }
        if sum > 0.0 {
            let inv = 1.0 / sum;
            for a in 0..n_act {
                let r = regrets[a * n_combo + i];
                out[a * n_combo + i] = if r > 0.0 { r * inv } else { 0.0 };
            }
        } else {
            for a in 0..n_act {
                out[a * n_combo + i] = uniform;
            }
        }
    }
}

/// Arena offsets [`accumulate`] reads, bundled so the signature stays readable.
#[derive(Clone, Copy)]
struct Slots {
    /// Current strategy at this node, action-major.
    sig: usize,
    /// Per-action child values, action-major.
    evs: usize,
    /// Where this node's value vector is written.
    out: usize,
    /// Hero's reach vector.
    h_off: usize,
}

/// The hero-decision update: node value into `buf[out..]`, then instantaneous regret
/// into `regrets` and the reach-weighted strategy into `strat`.
///
/// Free function taking the two regions as plain `&mut [f32]` so the `f32` mode can pass
/// the storage arrays themselves and the `i16` mode can pass decoded copies — the
/// arithmetic below is the same either way, and is the only place it is written.
#[inline]
fn accumulate(
    regrets: &mut [f32],
    strat: &mut [f32],
    buf: &mut [f32],
    s: Slots,
    hn: usize,
    n_act: usize,
    floor: bool,
) {
    let Slots { sig, evs, out, h_off } = s;
    buf[out..out + hn].fill(0.0);
    for a in 0..n_act {
        for i in 0..hn {
            let v = buf[sig + a * hn + i] * buf[evs + a * hn + i];
            buf[out + i] += v;
        }
    }
    for a in 0..n_act {
        for i in 0..hn {
            let regret = buf[evs + a * hn + i] - buf[out + i];
            let slot = &mut regrets[a * hn + i];
            *slot += regret;
            if floor && *slot < 0.0 {
                *slot = 0.0;
            }
            strat[a * hn + i] += buf[h_off + i] * buf[sig + a * hn + i];
        }
    }
}

/// Vector-form DCFR solver over any [`Game`].
pub struct Solver<G: Game> {
    game: G,
    /// Per node: start index into `regrets`/`strat_sum`, or `u32::MAX` for non-decision.
    offsets: Vec<u32>,
    /// Per node: `num_actions * combo_count(node, acting player)`, 0 for non-decision.
    sizes: Vec<u32>,
    regrets: Array,
    strat_sum: Array,
    scratch: Scratch,
    /// `f32` staging for whole-array passes and for the traversal's region codec.
    /// Grows to the largest region once and then stays put; unused in `f32` mode.
    codec: Vec<f32>,
    mode: StorageMode,
    iteration: u64,
}

impl<G: Game> Solver<G> {
    /// Walks the tree once to size and offset the per-node storage, in the default
    /// [`StorageMode::F32`].
    pub fn new(game: G) -> Self {
        Solver::new_with_storage(game, StorageMode::F32)
    }

    /// Same, choosing how the two big arrays are stored. See [`StorageMode`].
    ///
    /// `StorageMode::I16` roughly halves peak memory and changes nothing else about the
    /// API: the solve, the average strategy and the exploitability report all behave the
    /// same, to within the codec's quantization error.
    pub fn new_with_storage(game: G, mode: StorageMode) -> Self {
        let n = game.num_nodes();
        let mut offsets = vec![u32::MAX; n];
        let mut sizes = vec![0u32; n];
        let mut total = 0usize;
        for node in 0..n {
            if let NodeInfo::Decision { player, num_actions } = game.node(node as u32) {
                let size = num_actions.saturating_mul(game.combo_count(node as u32, player));
                // `offsets` is `u32` with `u32::MAX` reserved as the non-decision
                // sentinel, so every region must start below `u32::MAX`. Past that
                // `total as u32` truncated silently and aliased two nodes onto one
                // region; a solve that big is invalid either way, so refuse to build it.
                // `saturating_*` keeps the check honest on a 32-bit `usize` (wasm) and
                // against a `Game` reporting an absurd combo count.
                let want = total.saturating_add(size);
                assert!(
                    want < u32::MAX as usize,
                    "tree too large: {want} storage entries ({} bytes per array in f32 \
                     mode) exceed the {} a u32 offset can address; node {node} is where \
                     the limit is crossed",
                    want.saturating_mul(4),
                    u32::MAX as usize - 1,
                );
                offsets[node] = total as u32;
                sizes[node] = size as u32;
                total += size;
            }
        }
        Solver {
            game,
            offsets,
            sizes,
            regrets: Array::new(mode, total, n),
            strat_sum: Array::new(mode, total, n),
            scratch: Scratch::new(),
            codec: Vec::new(),
            mode,
            iteration: 0,
        }
    }

    pub fn game(&self) -> &G {
        &self.game
    }

    /// Iterations run so far.
    pub fn iterations(&self) -> u64 {
        self.iteration
    }

    /// How the two big arrays are stored.
    pub fn storage_mode(&self) -> StorageMode {
        self.mode
    }

    /// Bytes held by the cumulative-regret and cumulative-strategy arrays, scale tables
    /// included. This is the number the [`StorageMode`] choice moves.
    pub fn storage_bytes(&self) -> usize {
        self.regrets.bytes() + self.strat_sum.bytes()
    }

    /// Entries in each of the two arrays (`sum of num_actions * combo_count` over
    /// decision nodes) — the same count in either storage mode.
    pub fn storage_entries(&self) -> usize {
        self.regrets.entries()
    }

    /// DCFR discounting, applied once per full iteration `t` (1-based):
    /// positive regrets by `t^a / (t^a + 1)`, negative by `t^b / (t^b + 1)`, and the
    /// cumulative strategy by `(t / (t + 1))^g` so that iteration `t`'s contribution
    /// carries weight proportional to `t^g`.
    fn discount(&mut self, params: &DcfrParams) {
        let t = self.iteration as f64;
        let pos = {
            let ta = t.powf(params.alpha);
            (ta / (ta + 1.0)) as f32
        };
        let neg = {
            let tb = t.powf(params.beta);
            (tb / (tb + 1.0)) as f32
        };
        let strat = (t / (t + 1.0)).powf(params.gamma) as f32;

        // The strategy discount is one positive factor for every entry, so compressed it
        // is a pure scale-table multiply — exact, and no requantization.
        self.strat_sum.scale_all(strat);

        // Regrets take different factors either side of zero, so they need the values.
        if let Array::F32(r) = &mut self.regrets {
            for r in r.iter_mut() {
                *r *= if *r > 0.0 { pos } else { neg };
            }
            return;
        }
        // Compressed: the scale is per region, so go region by region — decode, apply
        // exactly the same `f32` multiply, encode back with a refreshed scale.
        for node in 0..self.sizes.len() {
            let size = self.sizes[node] as usize;
            if size == 0 {
                continue;
            }
            let off = self.offsets[node] as usize;
            if self.codec.len() < size {
                self.codec.resize(size, 0.0);
            }
            let buf = &mut self.codec[..size];
            self.regrets.decode_into(node as u32, off, buf);
            for r in buf.iter_mut() {
                *r *= if *r > 0.0 { pos } else { neg };
            }
            self.regrets.encode_from(node as u32, off, buf);
        }
    }
}

/// The iteration itself. `Sync` is required because the traversal hands `&G` to rayon
/// tasks at chance nodes; every `Game` in this crate satisfies it (they are plain
/// read-only tables built once).
impl<G: Game + Sync> Solver<G> {
    /// Runs `iterations` DCFR iterations.
    ///
    /// When `report_every > 0`, `report` is called after every `report_every`-th
    /// iteration with `(iteration, exploitability_chips, exploitability_pct_of_pot)`
    /// measured on the current average strategy. Computing that runs two full
    /// best-response walks, so keep the interval coarse on big trees.
    pub fn run(
        &mut self,
        iterations: u64,
        params: &DcfrParams,
        report_every: u64,
        mut report: impl FnMut(u64, f32, f32),
    ) {
        for _ in 0..iterations {
            self.iteration += 1;
            for hero in 0..2u8 {
                self.iterate(hero, params);
            }
            self.discount(params);
            if report_every > 0 && self.iteration.is_multiple_of(report_every) {
                let r = self.exploitability();
                report(self.iteration, r.chips, r.pct_of_pot);
            }
        }
    }

    /// One alternating half-iteration: update `hero`'s regrets and strategy sums
    /// against the opponent's current regret-matching strategy.
    fn iterate(&mut self, hero: u8, params: &DcfrParams) {
        let root = self.game.root();
        let opp = 1 - hero;
        let hn = self.game.combo_count(root, hero);
        let on = self.game.combo_count(root, opp);

        self.scratch.top = 0;
        let h_off = self.scratch.alloc(hn);
        let o_off = self.scratch.alloc(on);
        let out = self.scratch.alloc(hn);
        self.scratch.buf[h_off..h_off + hn].copy_from_slice(self.game.root_weights(hero));
        self.scratch.buf[o_off..o_off + on].copy_from_slice(self.game.root_weights(opp));

        let store = Store::new(&mut self.regrets, &mut self.strat_sum);
        let mut ctx = Cfr {
            game: &self.game,
            store,
            offsets: &self.offsets,
            sizes: &self.sizes,
            scratch: &mut self.scratch,
            dec: &mut self.codec,
            floor: params.floor_regrets_at_zero,
            fork: true,
        };
        ctx.walk(root, hero, h_off, hn, o_off, on, out);
    }
}

impl<G: Game> Solver<G> {
    /// Gamma-weighted average strategy at `node`, action-major
    /// (`[a * combo_count + i]`), normalized per combo.
    ///
    /// A combo that never reached `node` with positive probability has a zero
    /// cumulative strategy there and is reported as **uniform** over the actions.
    pub fn average_strategy(&self, node: u32) -> Vec<f32> {
        let size = self.sizes[node as usize] as usize;
        let mut out = vec![0.0; size];
        self.average_strategy_into(node, &mut out);
        out
    }

    /// Same as [`Solver::average_strategy`] into a caller-supplied buffer.
    pub fn average_strategy_into(&self, node: u32, out: &mut [f32]) {
        let NodeInfo::Decision { player, num_actions } = self.game.node(node) else {
            panic!("average_strategy on a non-decision node {node}");
        };
        let n_combo = self.game.combo_count(node, player);
        let off = self.offsets[node as usize] as usize;
        // Materialize the region into `out` (a copy in `f32` mode, a decode when
        // compressed) and normalize it in place.
        self.strat_sum.decode_into(node, off, &mut out[..num_actions * n_combo]);
        let uniform = 1.0 / num_actions as f32;
        for i in 0..n_combo {
            let mut total = 0.0f32;
            for a in 0..num_actions {
                total += out[a * n_combo + i].max(0.0);
            }
            if total > 0.0 {
                let inv = 1.0 / total;
                for a in 0..num_actions {
                    out[a * n_combo + i] = out[a * n_combo + i].max(0.0) * inv;
                }
            } else {
                for a in 0..num_actions {
                    out[a * n_combo + i] = uniform;
                }
            }
        }
    }

    /// The average strategy as a [`StrategyProfile`] for [`crate::br`].
    pub fn average(&self) -> AverageStrategy<'_, G> {
        AverageStrategy { solver: self }
    }

    /// Exploitability of the current average strategy.
    pub fn exploitability(&self) -> ExploitReport {
        br::exploitability(&self.game, &self.average())
    }

    /// Player `hero`'s expected value in chips under the current average strategy
    /// profile (both players playing their average).
    pub fn expected_value(&self, hero: u8) -> f32 {
        br::expected_value(&self.game, hero, &self.average())
    }
}

/// Read-only view of a [`Solver`]'s average strategy.
pub struct AverageStrategy<'a, G: Game> {
    solver: &'a Solver<G>,
}

impl<G: Game> StrategyProfile for AverageStrategy<'_, G> {
    fn strategy_into(&self, node: u32, out: &mut [f32]) {
        self.solver.average_strategy_into(node, out);
    }
}

/// Borrowed traversal context. `game` is a plain shared reference (not a field of the
/// mutably-borrowed struct), so chance-edge slices stay valid across recursive calls.
struct Cfr<'a, G: Game> {
    game: &'a G,
    store: Store,
    offsets: &'a [u32],
    /// Per node: the region length [`Solver::new_with_storage`] actually allocated. The
    /// traversal derives its own length from the reach vector it carries; the two agree
    /// only while the `Game` honours the decision-edge invariant, so [`Cfr::region`]
    /// checks it before any `Store` access. See [`Cfr::region`].
    sizes: &'a [u32],
    scratch: &'a mut Scratch,
    /// `f32` staging for the region codec under [`StorageMode::I16`], reused across
    /// node visits. A separate field from `scratch` so a decoded region and the
    /// traversal arena can be borrowed at once; never held across a recursive call, so
    /// it needs no stack discipline. Stays empty in `f32` mode.
    dec: &'a mut Vec<f32>,
    floor: bool,
    /// Whether this context is still allowed to fork at a chance node. True on the main
    /// thread, false inside a task — only the outermost chance node on a path forks, so
    /// there is exactly one fork level and the disjointness argument in [`Store`] holds.
    ///
    /// Only the `parallel` feature reads it; without rayon every walk is sequential.
    #[cfg_attr(not(feature = "parallel"), allow(dead_code))]
    fork: bool,
}

impl<G: Game + Sync> Cfr<'_, G> {
    /// Length of decision `node`'s storage region, checked against `want` — the length
    /// this traversal derived from the reach vector it is carrying.
    ///
    /// Every unsafe [`Store`] access materializes `offsets[node] .. + len`, so this is
    /// what keeps that slice inside the node's own allocation for **any safe [`Game`]**,
    /// including one that violates the decision-edge invariant and hands the traversal a
    /// wider reach vector than the region was sized for. A panic here is a `Game` bug; an
    /// unchecked slice would be undefined behaviour. One compare per decision node.
    #[inline]
    fn region(&self, node: u32, want: usize) -> usize {
        let have = self.sizes[node as usize] as usize;
        assert!(
            want == have,
            "node {node}: storage was allocated {have} entries but the traversal reached \
             it carrying a reach vector implying {want}; the Game must make decision \
             edges preserve combo sets (invariant 1 in crate::game)"
        );
        have
    }

    /// Writes hero's counterfactual value vector for the subtree at `node` into
    /// `scratch[out .. out + hn]`, updating hero's regrets and strategy sums on the way.
    ///
    /// `h_off`/`hn` is hero's reach vector, `o_off`/`on` the opponent's (which carries
    /// the chance weights).
    #[allow(clippy::too_many_arguments)]
    fn walk(
        &mut self,
        node: u32,
        hero: u8,
        h_off: usize,
        hn: usize,
        o_off: usize,
        on: usize,
        out: usize,
    ) {
        let g = self.game;
        match g.node(node) {
            NodeInfo::Terminal => {
                let (r, w) = read_write(&mut self.scratch.buf, o_off, on, out, hn);
                g.terminal_utility(node, hero, r, w);
            }
            #[cfg(feature = "parallel")]
            NodeInfo::Chance { num_outcomes } if self.fork && num_outcomes >= PAR_MIN_OUTCOMES => {
                // PARALLEL MAP: one task per outcome, each with its own arena and its own
                // node-disjoint slice of storage (see `Store`). `map_init` keeps one arena
                // per rayon worker alive across the outcomes it happens to take, so the
                // steady state allocates only the returned value vectors.
                let (store, offsets, sizes, floor) =
                    (self.store, self.offsets, self.sizes, self.floor);
                let parent: &[f32] = &self.scratch.buf;
                let results: Vec<Vec<f32>> = (0..num_outcomes)
                    .into_par_iter()
                    .map_init(|| (Scratch::new(), Vec::new()), |(sc, dec), k| {
                        let edge = g.chance_outcome(node, k);
                        let map_h = edge.parent_of_child[hero as usize];
                        let map_o = edge.parent_of_child[(1 - hero) as usize];
                        let (chn, con) = (map_h.len(), map_o.len());
                        sc.top = 0;
                        let ch = sc.alloc(chn);
                        let co = sc.alloc(con);
                        let cout = sc.alloc(chn);
                        for (t, &p) in map_h.iter().enumerate() {
                            sc.buf[ch + t] = parent[h_off + p as usize];
                        }
                        for (t, &p) in map_o.iter().enumerate() {
                            sc.buf[co + t] = parent[o_off + p as usize] * edge.weight;
                        }
                        let mut ctx = Cfr {
                            game: g,
                            store,
                            offsets,
                            sizes,
                            scratch: sc,
                            dec,
                            floor,
                            fork: false,
                        };
                        ctx.walk(edge.child, hero, ch, chn, co, con, cout);
                        sc.buf[cout..cout + chn].to_vec()
                    })
                    .collect();

                // SEQUENTIAL REDUCE, ascending outcome order — the same order and the same
                // additions the sequential branch below performs, so the sum is bit-identical
                // however the tasks were scheduled.
                self.scratch.zero(out, hn);
                for (k, vals) in results.iter().enumerate() {
                    let map_h = g.chance_outcome(node, k).parent_of_child[hero as usize];
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[out + p as usize] += vals[t];
                    }
                }
            }
            NodeInfo::Chance { num_outcomes } => {
                self.scratch.zero(out, hn);
                for k in 0..num_outcomes {
                    let edge = g.chance_outcome(node, k);
                    let map_h = edge.parent_of_child[hero as usize];
                    let map_o = edge.parent_of_child[(1 - hero) as usize];
                    let (chn, con) = (map_h.len(), map_o.len());
                    let save = self.scratch.top;
                    let ch = self.scratch.alloc(chn);
                    let co = self.scratch.alloc(con);
                    let cout = self.scratch.alloc(chn);
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[ch + t] = self.scratch.buf[h_off + p as usize];
                    }
                    for (t, &p) in map_o.iter().enumerate() {
                        self.scratch.buf[co + t] =
                            self.scratch.buf[o_off + p as usize] * edge.weight;
                    }
                    self.walk(edge.child, hero, ch, chn, co, con, cout);
                    for (t, &p) in map_h.iter().enumerate() {
                        self.scratch.buf[out + p as usize] += self.scratch.buf[cout + t];
                    }
                    self.scratch.top = save;
                }
            }
            NodeInfo::Decision { player, num_actions } if player == hero => {
                let store = self.store;
                let off = self.offsets[node as usize] as usize;
                let size = self.region(node, num_actions * hn);
                let base = self.scratch.top;
                let sig = self.scratch.alloc(size);
                let evs = self.scratch.alloc(size);
                // SAFETY: `off..off + size` is exactly this node's own region, and this
                // task is the only one that reaches this node (see `Store`).
                match unsafe { store.regrets(off, size) } {
                    Some(regrets) => regret_matching(
                        regrets,
                        num_actions,
                        hn,
                        &mut self.scratch.buf[sig..sig + size],
                    ),
                    None => {
                        let dec = &mut *self.dec;
                        if dec.len() < size {
                            dec.resize(size, 0.0);
                        }
                        // SAFETY: as above.
                        unsafe { store.regrets.load(node, off, &mut dec[..size]) };
                        regret_matching(
                            &dec[..size],
                            num_actions,
                            hn,
                            &mut self.scratch.buf[sig..sig + size],
                        );
                    }
                }
                for a in 0..num_actions {
                    let save = self.scratch.top;
                    let ch = self.scratch.alloc(hn);
                    for i in 0..hn {
                        self.scratch.buf[ch + i] =
                            self.scratch.buf[h_off + i] * self.scratch.buf[sig + a * hn + i];
                    }
                    self.walk(g.child(node, a), hero, ch, hn, o_off, on, evs + a * hn);
                    self.scratch.top = save;
                }
                // SAFETY: as above — this node's own region, reached by this task only.
                match unsafe { (store.regrets(off, size), store.strat(off, size)) } {
                    // `f32`: update the arrays in place, no copies.
                    (Some(regrets), Some(strat)) => accumulate(
                        regrets,
                        strat,
                        &mut self.scratch.buf,
                        Slots { sig, evs, out, h_off },
                        hn,
                        num_actions,
                        self.floor,
                    ),
                    // `i16`: decode both regions, run the identical `f32` update on the
                    // decoded copies, encode back with refreshed scales.
                    _ => {
                        let dec = &mut *self.dec;
                        if dec.len() < 2 * size {
                            dec.resize(2 * size, 0.0);
                        }
                        let (r, s) = dec[..2 * size].split_at_mut(size);
                        // SAFETY: as above.
                        unsafe {
                            store.regrets.load(node, off, r);
                            store.strat.load(node, off, s);
                        }
                        accumulate(
                            r,
                            s,
                            &mut self.scratch.buf,
                            Slots { sig, evs, out, h_off },
                            hn,
                            num_actions,
                            self.floor,
                        );
                        // SAFETY: as above.
                        unsafe {
                            store.regrets.store(node, off, r);
                            store.strat.store(node, off, s);
                        }
                    }
                }
                self.scratch.top = base;
            }
            NodeInfo::Decision { player, num_actions } => {
                debug_assert_eq!(player, 1 - hero);
                let off = self.offsets[node as usize] as usize;
                let size = self.region(node, num_actions * on);
                let base = self.scratch.top;
                let sig = self.scratch.alloc(size);
                // SAFETY: read-only use of this node's own region; see `Store`.
                match unsafe { self.store.regrets(off, size) } {
                    Some(regrets) => regret_matching(
                        regrets,
                        num_actions,
                        on,
                        &mut self.scratch.buf[sig..sig + size],
                    ),
                    None => {
                        let store = self.store;
                        let dec = &mut *self.dec;
                        if dec.len() < size {
                            dec.resize(size, 0.0);
                        }
                        // SAFETY: as above.
                        unsafe { store.regrets.load(node, off, &mut dec[..size]) };
                        regret_matching(
                            &dec[..size],
                            num_actions,
                            on,
                            &mut self.scratch.buf[sig..sig + size],
                        );
                    }
                }
                self.scratch.zero(out, hn);
                for a in 0..num_actions {
                    let save = self.scratch.top;
                    let co = self.scratch.alloc(on);
                    let tmp = self.scratch.alloc(hn);
                    for i in 0..on {
                        self.scratch.buf[co + i] =
                            self.scratch.buf[o_off + i] * self.scratch.buf[sig + a * on + i];
                    }
                    self.walk(g.child(node, a), hero, h_off, hn, co, on, tmp);
                    for i in 0..hn {
                        self.scratch.buf[out + i] += self.scratch.buf[tmp + i];
                    }
                    self.scratch.top = save;
                }
                self.scratch.top = base;
            }
        }
    }
}

#[cfg(test)]
mod compressed_tests {
    use std::time::Instant;

    use super::*;
    use crate::config::{Sizings, SolveConfig};
    use crate::nlhe::NlheGame;

    /// Encode/decode is a codec and nothing more, so the whole contract is the error
    /// bound — proved on the shapes the solver actually produces: mixed-sign regions
    /// (`floor_regrets_at_zero` is off by default, so cumulative regret goes negative),
    /// all-zero regions (every node before its first visit), and a region whose max
    /// **grows** between iterations, which is the case the per-region scale refresh
    /// exists for.
    #[test]
    fn i16_codec_round_trip_respects_its_error_bound() {
        let cases: [(&str, &[f32]); 6] = [
            ("zeros", &[0.0; 16]),
            ("mixed sign", &[-3.5, 0.0, 1.25, -0.001, 7.0, -7.0, 0.5, 2.0]),
            ("all negative", &[-1.0, -0.25, -9.5, -0.0001]),
            ("tiny", &[1e-9, -4e-9, 2.5e-9]),
            ("huge", &[-1.2e6, 3.4e5, 0.0, 9.9e5]),
            ("single", &[-42.0]),
        ];
        for (tag, src) in cases {
            let mut q = vec![0i16; src.len()];
            let scale = encode(src, &mut q);
            let mut back = vec![0.0f32; src.len()];
            decode(&q, scale, &mut back);

            let want = src.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            assert_eq!(scale, want, "{tag}: scale must be the region max-abs");

            // Half a quantum, plus slack for the two `f32` multiplies in the round trip.
            let bound = scale / Q_MAX * 0.5 * 1.001 + f32::MIN_POSITIVE;
            let err =
                src.iter().zip(&back).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            println!(
                "codec {tag:>12}: n={:<3} scale={scale:.6e}  max err={err:.6e}  bound={bound:.6e}",
                src.len()
            );
            assert!(err <= bound, "{tag}: error {err} exceeds half-quantum bound {bound}");

            if scale == 0.0 {
                assert!(q.iter().all(|&x| x == 0), "{tag}: zero region encodes to zeros");
                assert!(back.iter().all(|&v| v == 0.0), "{tag}: zero region decodes to zeros");
            } else {
                // The extreme entry uses the full i16 range — no headroom wasted, no wrap.
                let extreme = q.iter().map(|&x| x.abs() as i32).max().unwrap();
                assert_eq!(extreme, 32767, "{tag}: max-abs entry should saturate the range");
            }
        }

        // The scale refresh. A region whose max grows 900x must not clip, and one whose
        // max shrinks must regain resolution. A stale scale would fail both.
        let mut q = vec![0i16; 4];
        let mut back = vec![0.0f32; 4];
        assert_eq!(encode(&[1.0, -0.5, 0.25, 0.0], &mut q), 1.0);

        let grown = [1.0f32, -0.5, 0.25, 900.0];
        let scale = encode(&grown, &mut q);
        assert_eq!(scale, 900.0, "scale refreshed to the grown max");
        decode(&q, scale, &mut back);
        let err = grown.iter().zip(&back).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        println!("codec  grown max: scale={scale}  max err={err:.6e}  decoded={back:?}");
        assert!(err <= scale / Q_MAX * 0.501, "grown region error {err}");

        let shrunk = [0.001f32, -0.0005, 0.00025, 0.0];
        let scale = encode(&shrunk, &mut q);
        assert_eq!(scale, 0.001, "scale refreshed down to the shrunk max");
        decode(&q, scale, &mut back);
        let err = shrunk.iter().zip(&back).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        println!("codec shrunk max: scale={scale}  max err={err:.6e}  decoded={back:?}");
        assert!(err <= scale / Q_MAX * 0.501, "shrunk region error {err}");
    }

    /// The scale refresh again, but through the traversal's raw-pointer path
    /// ([`ArrayPtr::store`] / [`ArrayPtr::load`]) instead of the codec functions.
    ///
    /// That path is what the hot loop takes, and it is where a scale set once and never
    /// refreshed would clip every region that outgrows its first write — cumulative
    /// regret and cumulative strategy both grow monotonically from tiny first-iteration
    /// values, so that bug is not hypothetical. The full solve below catches it too, in
    /// 17 seconds; this catches it in microseconds.
    #[test]
    fn i16_region_write_refreshes_the_scale() {
        let mut regrets = Array::new(StorageMode::I16, 8, 2);
        let mut strat = Array::new(StorageMode::I16, 8, 2);
        let store = Store::new(&mut regrets, &mut strat);
        let mut back = [0.0f32; 4];

        // Node 1 owns entries 4..8. Write a small region, then one 1000x larger.
        for src in [[0.5f32, -0.25, 0.125, 0.0], [500.0, -250.0, 125.0, 0.0]] {
            // SAFETY: this is node 1's own region and nothing else refers to it.
            unsafe {
                store.regrets.store(1, 4, &src);
                store.regrets.load(1, 4, &mut back);
            }
            let err = src.iter().zip(&back).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            println!("region write: max {:>5} -> decoded {back:?}, max err {err:.6e}", src[0]);
            assert!(
                err <= src[0].abs() / Q_MAX * 0.501,
                "stale scale: {src:?} read back as {back:?}"
            );
        }

        // Node 0's region was never written and still reads as zeros — one node's
        // scale refresh must not reach into another's.
        // SAFETY: node 0's own region.
        unsafe { store.regrets.load(0, 0, &mut back) };
        assert_eq!(back, [0.0; 4], "untouched region is not zero");
        // And the strategy array is independent of the regret array.
        // SAFETY: node 1's own region in the other array.
        unsafe { store.strat.load(1, 4, &mut back) };
        assert_eq!(back, [0.0; 4], "writing regrets disturbed the strategy array");
    }

    /// The same tight flop spot the always-on milestone-4 gate uses: real multi-street
    /// tree, 70 vs 63 combos, one bet size per street, no raises.
    fn small_flop_cfg() -> SolveConfig {
        let mut cfg = SolveConfig {
            board: "Qs Jh 2h".to_string(),
            oop_range: "88+,AJs+,KQs,AQo+".to_string(),
            ip_range: "99+,AJs+,AQo+".to_string(),
            effective_stack: 40.0,
            starting_pot: 6.0,
            raise_cap: 0,
            ..SolveConfig::default()
        };
        for p in [0u8, 1] {
            let s = if p == 0 { &mut cfg.sizings.oop } else { &mut cfg.sizings.ip };
            s.flop.bet = Sizings::new(&[50.0], false);
            s.turn.bet = Sizings::new(&[75.0], false);
            s.river.bet = Sizings::new(&[75.0], false);
        }
        cfg
    }

    fn decision_nodes(g: &NlheGame) -> Vec<u32> {
        (0..g.num_nodes() as u32)
            .filter(|&n| matches!(g.node(n), NodeInfo::Decision { .. }))
            .collect()
    }

    /// GATE. Solve the small-flop spot twice — `f32` and `i16` — and hold the compressed
    /// run to the uncompressed one on all three things that matter: the exploitability
    /// curve, the final exploitability gate, and the average strategies themselves.
    #[test]
    fn i16_storage_matches_f32_on_the_small_flop_gate() {
        let cfg = small_flop_cfg();
        let params = DcfrParams::from_config(&cfg);
        let (iters, every) = (200u64, 25u64);

        let mut runs = Vec::new();
        for mode in [StorageMode::F32, StorageMode::I16] {
            let game = NlheGame::new(&cfg).expect("game builds");
            let mut s = Solver::new_with_storage(game, mode);
            let mut log: Vec<(u64, f32, f32)> = Vec::new();
            let t0 = Instant::now();
            s.run(iters, &params, every, |i, c, p| log.push((i, c, p)));
            let wall = t0.elapsed();
            println!(
                "{mode:?}: {iters} iters + {} reports in {wall:?}  |  storage {} B \
                 ({:.3} MB) for 2 x {} entries",
                log.len(),
                s.storage_bytes(),
                s.storage_bytes() as f64 / 1.048576e6,
                s.storage_entries(),
            );
            for (i, chips, pct) in &log {
                println!("  {mode:?} iter {i:>4}  {chips:.9} chips  {pct:.6}% of pot");
            }
            runs.push((s, log));
        }
        let (f32_solver, f32_log) = &runs[0];
        let (i16_solver, i16_log) = &runs[1];

        // Gates are collected rather than asserted on the spot, so a failing run still
        // prints every measurement below it — which is what you need to tell a codec bug
        // from a threshold that wants revisiting.
        let mut fails: Vec<String> = Vec::new();
        macro_rules! gate {
            ($cond:expr, $($arg:tt)*) => {{
                let ok: bool = $cond;
                if !ok {
                    fails.push(format!($($arg)*));
                }
            }};
        }

        // ---- MEMORY: counts beside the verdict -------------------------------
        let (fb, ib) = (f32_solver.storage_bytes(), i16_solver.storage_bytes());
        let entries = f32_solver.storage_entries();
        println!(
            "MEMORY: {entries} entries x 2 arrays -> f32 {fb} B, i16 {ib} B, ratio {:.4} \
             (i16 payload {} B + scales {} B for {} nodes)",
            ib as f64 / fb as f64,
            entries * 2 * 2,
            ib - entries * 2 * 2,
            f32_solver.game().num_nodes(),
        );
        assert_eq!(fb, entries * 2 * 4, "f32 storage is 4 bytes per entry per array");
        gate!(ib < fb * 6 / 10, "i16 storage {ib} B is not meaningfully below f32 {fb} B");

        // ---- CURVES ----------------------------------------------------------
        //
        // The compressed run tracks the reference closely while exploitability is well
        // above the quantization floor, then flattens onto that floor while the
        // reference keeps descending. That plateau is inherent to a fixed-point
        // accumulator, not a defect: a contribution smaller than half a quantum rounds
        // to zero at every commit and can never accumulate.
        //
        // MEASURED on this spot (after the 2026-09-01 chance-weight correction — the
        // corrected game converges faster, so pointwise relative gaps on the chaotic
        // early curve widened; worst observed 26.9% at iter 100): within 50% wherever
        // the reference is above `TRACK_ABOVE`, and the floor is ~0.01 chips against
        // the reference's ~0.007 at iteration 200. Below `TRACK_ABOVE` the compressed
        // run must still stay within 2x.
        const TRACK_ABOVE: f32 = 0.02;
        const BAND: f64 = 0.50;
        assert_eq!(f32_log.len(), i16_log.len());
        let (mut worst, mut tracked) = ((0u64, 0.0f64), 0usize);
        for (a, b) in f32_log.iter().zip(i16_log) {
            assert_eq!(a.0, b.0);
            let rel = ((b.1 - a.1) / a.1) as f64;
            println!(
                "curve iter {:>4}: f32 {:.9}  i16 {:.9}  relative {:+.4}%{}",
                a.0,
                a.1,
                b.1,
                rel * 100.0,
                if a.1 >= TRACK_ABOVE { "  [50% gate]" } else { "  [2x gate]" }
            );
            gate!(
                b.1 <= a.1 * 2.0,
                "iter {}: i16 exploitability {} is more than 2x the f32 {}",
                a.0,
                b.1,
                a.1
            );
            if a.1 >= TRACK_ABOVE {
                tracked += 1;
                if rel.abs() > worst.1 {
                    worst = (a.0, rel.abs());
                }
            }
        }
        println!(
            "curve: {tracked} of {} reports above {TRACK_ABOVE} chips held to 50%; MEASURED \
             worst relative gap there {:.4}% at iter {}",
            f32_log.len(),
            worst.1 * 100.0,
            worst.0
        );
        gate!(tracked >= 3, "only {tracked} reports landed in the tracked band");
        gate!(
            worst.1 <= BAND,
            "exploitability curves differ by {:.4}% at iter {} (limit {:.0}%)",
            worst.1 * 100.0,
            worst.0,
            BAND * 100.0
        );
        // The compressed run converges on its own terms, not just relative to f32.
        gate!(
            i16_log.last().unwrap().1 * 5.0 < i16_log[0].1,
            "i16 exploitability {} is not 5x below its first report {}",
            i16_log.last().unwrap().1,
            i16_log[0].1
        );

        // ---- FINAL: both under the same gate --------------------------------
        let (ef, ei) = (f32_solver.exploitability(), i16_solver.exploitability());
        let (v0, v1) = (i16_solver.expected_value(0), i16_solver.expected_value(1));
        println!(
            "FINAL: f32 {:.6}% of pot, i16 {:.6}% of pot (gate 1%)  |  i16 EV {v0:.6} + \
             {v1:.6} = {:.9}",
            ef.pct_of_pot,
            ei.pct_of_pot,
            v0 + v1
        );
        gate!(ef.pct_of_pot < 1.0, "f32 exploitability {}% of pot", ef.pct_of_pot);
        gate!(ei.pct_of_pot < 1.0, "i16 exploitability {}% of pot", ei.pct_of_pot);
        gate!((v0 + v1).abs() < 1e-3, "i16 run is not zero-sum: {}", v0 + v1);

        // ---- STRATEGIES: max abs per-action-per-combo difference -------------
        //
        // A raw diff against the reference is not on its own interpretable here, because
        // *any* perturbation of a DCFR trajectory reshuffles the per-combo mixes wherever
        // actions are close to indifferent — the equilibrium is not unique. So the
        // comparison is calibrated against a control that isolates that effect: the same
        // spot, the same `f32` storage, the same iteration count, with the discount
        // exponent nudged by 1e-7 — a perturbation roughly a thousand times SMALLER than
        // one i16 quantum. Whatever spread that control shows is the game's, not the
        // codec's.
        //
        // MEASURED: control max 0.896943 / rms 3.19e-2; i16 max 0.989831 / rms 9.50e-2,
        // i.e. the codec moves the strategies about 3x as much as a 1e-7 nudge does,
        // while landing at the same exploitability. Both runs are equilibria of the
        // same spot; neither max is a defect, and the gate below is on the ratio.
        let g = f32_solver.game();
        let nodes = decision_nodes(g);

        let control = {
            let game = NlheGame::new(&cfg).expect("game builds");
            let mut ctl = Solver::new_with_storage(game, StorageMode::F32);
            ctl.run(iters, &DcfrParams { alpha: params.alpha + 1e-7, ..params }, 0, |_, _, _| {});
            ctl
        };
        println!(
            "CONTROL (f32, alpha {:+.0e}): exploitability {:.6}% of pot",
            1e-7,
            control.exploitability().pct_of_pot
        );

        // (max abs diff, node, action, combo, sum of squares) for i16 and for the control.
        let mut stats = [(0.0f32, 0u32, 0usize, 0usize, 0.0f64); 2];
        let mut count = 0usize;
        for &n in &nodes {
            let NodeInfo::Decision { player, num_actions } = g.node(n) else { unreachable!() };
            let n_combo = g.combo_count(n, player);
            let a = f32_solver.average_strategy(n);
            let others = [i16_solver.average_strategy(n), control.average_strategy(n)];
            for act in 0..num_actions {
                for i in 0..n_combo {
                    let k = act * n_combo + i;
                    count += 1;
                    for (s, o) in stats.iter_mut().zip(&others) {
                        let d = (a[k] - o[k]).abs();
                        s.4 += (d as f64) * (d as f64);
                        if d > s.0 {
                            *s = (d, n, act, i, s.4);
                        }
                    }
                }
            }
        }
        let rms = |s: &(f32, u32, usize, usize, f64)| (s.4 / count as f64).sqrt();
        for (tag, s) in ["i16 vs f32", "control vs f32"].iter().zip(&stats) {
            println!(
                "STRATEGY {tag:>15}: {count} probabilities over {} decision nodes, MEASURED \
                 max abs diff {:.6} (node {} action {} combo {}), rms {:.6e}",
                nodes.len(),
                s.0,
                s.1,
                s.2,
                s.3,
                rms(s)
            );
        }
        let ratio = rms(&stats[0]) / rms(&stats[1]);
        println!("STRATEGY MEASURED rms ratio i16 / control = {ratio:.3} (gate 10x)");
        gate!(
            ratio <= 10.0,
            "i16 moves the average strategies {ratio:.3}x as much as a 1e-7 discount nudge; \
             that is beyond trajectory chaos and points at the codec"
        );

        assert!(fails.is_empty(), "{} gate(s) failed:\n  {}", fails.len(), fails.join("\n  "));
    }

    /// Determinism must survive compression: the codec is elementwise and the reduction
    /// order is untouched, so the answer still cannot depend on how many threads
    /// computed it.
    #[cfg(feature = "parallel")]
    #[test]
    fn i16_storage_is_thread_count_independent() {
        let cfg = small_flop_cfg();
        let params = DcfrParams::from_config(&cfg);
        let iters = 20u64;

        let run = |threads: usize| {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("rayon pool builds");
            pool.install(|| {
                assert_eq!(rayon::current_num_threads(), threads);
                let game = NlheGame::new(&cfg).expect("game builds");
                let mut s = Solver::new_with_storage(game, StorageMode::I16);
                s.run(iters, &params, 0, |_, _, _| {});
                // Fingerprint every average strategy by raw bit pattern — no epsilon.
                let mut h = 0xcbf2_9ce4_8422_2325u64;
                for n in decision_nodes(s.game()) {
                    for v in s.average_strategy(n) {
                        h ^= v.to_bits() as u64;
                        h = h.wrapping_mul(0x0000_0100_0000_01b3);
                    }
                }
                (s.exploitability().chips, s.expected_value(0), h)
            })
        };

        let mut baseline: Option<(f32, f32, u64)> = None;
        for threads in [1usize, 3, 8] {
            let got = run(threads);
            println!(
                "i16 determinism: {threads:>2} thread(s), {iters} iters  exploitability \
                 {:.9}  EV(OOP) {:.9}  fingerprint {:#018x}",
                got.0, got.1, got.2
            );
            match baseline {
                None => baseline = Some(got),
                Some(want) => assert_eq!(
                    got, want,
                    "i16 result differs at {threads} threads: {got:?} vs {want:?}"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::ChanceEdge;

    /// Smallest game that exercises the chance machinery the NLHE tree will lean on:
    /// a chance edge that **shrinks** both players' combo sets, with a different
    /// surviving subsequence per outcome.
    ///
    /// Three cards 0 < 1 < 2. A public card `p` is dealt uniformly, killing card `p` in
    /// both players' ranges, so each child has 2 live combos instead of 3 and the
    /// parent->child map differs per outcome (`p=0 -> [1,2]`, `p=1 -> [0,2]`,
    /// `p=2 -> [0,1]`). Each player then holds one of the two survivors — and since they
    /// cannot hold the same card, holding the higher survivor means *certainly* winning
    /// the showdown. Player 0 alone acts: fold for a flat -0.5, or show down for ±1.
    ///
    /// So the optimum is obvious and the value is hand-checkable: player 0 shows down
    /// the higher survivor (+1) and folds the lower (-0.5), each half the time, for
    /// **+0.25 per hand**.
    ///
    /// The normalizer is the interesting part and is why this test earns its keep. The
    /// root joint mass is 6 compatible pairs, but the chance edge kills a card, so only
    /// 2 ordered pairs survive each outcome and the outcome weights sum to 1:
    /// total terminal mass is `3 * (1/3) * 2 = 2`, not 6. A traversal that forgot to
    /// weight by the chance probability, or that expanded child values into the wrong
    /// parent slots, cannot land on +0.25.
    struct PublicCard {
        weights: [f32; 3],
        /// Surviving parent slots per public card.
        live: [[u32; 2]; 3],
    }

    impl PublicCard {
        fn new() -> Self {
            PublicCard { weights: [1.0; 3], live: [[1, 2], [0, 2], [0, 1]] }
        }
    }

    impl Game for PublicCard {
        fn root(&self) -> u32 {
            0
        }
        fn num_nodes(&self) -> usize {
            10
        }
        fn node(&self, node: u32) -> NodeInfo {
            match node {
                0 => NodeInfo::Chance { num_outcomes: 3 },
                1..=3 => NodeInfo::Decision { player: 0, num_actions: 2 },
                4..=9 => NodeInfo::Terminal,
                _ => unreachable!(),
            }
        }
        fn child(&self, node: u32, action: usize) -> u32 {
            // node 1+p: fold -> 4+p, showdown -> 7+p
            match action {
                0 => node + 3,
                1 => node + 6,
                _ => unreachable!(),
            }
        }
        fn combo_count(&self, node: u32, _player: u8) -> usize {
            if node == 0 {
                3
            } else {
                2
            }
        }
        fn root_weights(&self, _player: u8) -> &[f32] {
            &self.weights
        }
        fn chance_outcome(&self, node: u32, outcome: usize) -> ChanceEdge<'_> {
            assert_eq!(node, 0);
            let m = &self.live[outcome];
            ChanceEdge { child: 1 + outcome as u32, weight: 1.0 / 3.0, parent_of_child: [m, m] }
        }
        fn terminal_utility(&self, node: u32, hero: u8, opp_reach: &[f32], out: &mut [f32]) {
            // 4..=6 fold (flat -0.5 to player 0), 7..=9 showdown (higher survivor wins 1).
            let showdown = node >= 7;
            for (i, slot) in out.iter_mut().enumerate() {
                let mut v = 0.0;
                for (j, &w) in opp_reach.iter().enumerate() {
                    if i == j {
                        continue;
                    }
                    // Showdown is symmetric in hero: `i` is always hero's own card, so
                    // hero wins whenever its own slot is the higher survivor. The fold
                    // terminal is asymmetric: player 0 is the one giving up 0.5.
                    let u_hero = if showdown {
                        if i > j {
                            1.0
                        } else {
                            -1.0
                        }
                    } else if hero == 0 {
                        -0.5
                    } else {
                        0.5
                    };
                    v += w * u_hero;
                }
                *slot = v;
            }
        }
        fn normalizer(&self) -> f32 {
            2.0
        }
        fn root_pot(&self) -> f32 {
            1.0
        }
    }

    /// A safe `Game` that violates invariant 1 in [`crate::game`]: node 1 is a decision
    /// child of decision node 0 but reports a *smaller* combo count. `Solver::new` sizes
    /// node 1's region from `combo_count` (2 entries) while the traversal reaches it
    /// carrying the parent's 4-wide reach vector (8 entries), so the raw-pointer slice in
    /// the hero branch would run 6 entries past the whole allocation.
    ///
    /// Nothing here is `unsafe`, so this must be a panic, never UB.
    struct ShrinkingDecisionEdge {
        weights: [f32; 4],
    }

    impl Game for ShrinkingDecisionEdge {
        fn root(&self) -> u32 {
            0
        }
        fn num_nodes(&self) -> usize {
            4
        }
        fn node(&self, node: u32) -> NodeInfo {
            match node {
                0 | 1 => NodeInfo::Decision { player: 0, num_actions: 2 },
                _ => NodeInfo::Terminal,
            }
        }
        fn child(&self, node: u32, action: usize) -> u32 {
            // node 0: action 0 -> the lying node 1, action 1 -> terminal 2.
            // node 1: terminals 2 and 3.
            if node == 0 && action == 0 {
                1
            } else {
                2 + action as u32
            }
        }
        fn combo_count(&self, node: u32, _player: u8) -> usize {
            if node == 0 {
                4
            } else {
                1 // THE LIE: a decision edge may not shrink a combo set.
            }
        }
        fn root_weights(&self, _player: u8) -> &[f32] {
            &self.weights
        }
        fn chance_outcome(&self, _node: u32, _outcome: usize) -> ChanceEdge<'_> {
            unreachable!("no chance nodes")
        }
        fn terminal_utility(&self, _node: u32, _hero: u8, _opp_reach: &[f32], out: &mut [f32]) {
            out.fill(0.0);
        }
        fn normalizer(&self) -> f32 {
            1.0
        }
        fn root_pot(&self) -> f32 {
            1.0
        }
    }

    /// REGRESSION. The `unsafe` region slices in [`Cfr::walk`] must be sound for every
    /// safe [`Game`], not just well-behaved ones. Before the fix the traversal sized them
    /// from its own reach vector and the only guard was a `debug_assert` inside
    /// [`Store::regrets`] — so a debug build tripped an assertion about `off + n` and a
    /// release build wrote out of bounds (observed as a heap access violation).
    #[test]
    #[should_panic(expected = "decision edges preserve combo sets")]
    fn a_shrinking_decision_edge_panics_instead_of_writing_out_of_bounds() {
        let mut s = Solver::new(ShrinkingDecisionEdge { weights: [1.0; 4] });
        s.run(1, &DcfrParams::default(), 0, |_, _, _| {});
    }

    /// A tree whose storage needs more entries than a `u32` offset can address.
    ///
    /// Node 2's `combo_count` is a tripwire: reaching it means the sizing loop sailed
    /// past the limit, which is exactly the pre-fix behaviour — it then went on to ask
    /// for two ~17 GB arrays with node 1's offset silently truncated. The tripwire keeps
    /// the red run cheap and allocation-free.
    struct TooBigForU32Offsets;

    impl Game for TooBigForU32Offsets {
        fn root(&self) -> u32 {
            0
        }
        fn num_nodes(&self) -> usize {
            3
        }
        fn node(&self, _node: u32) -> NodeInfo {
            NodeInfo::Decision { player: 0, num_actions: 1 }
        }
        fn child(&self, node: u32, _action: usize) -> u32 {
            node + 1
        }
        fn combo_count(&self, node: u32, _player: u8) -> usize {
            assert!(node < 2, "sizing loop ran past the u32 offset limit, reached node {node}");
            2_200_000_000 // two of these overflow u32::MAX entries; one does not.
        }
        fn root_weights(&self, _player: u8) -> &[f32] {
            &[]
        }
        fn chance_outcome(&self, _node: u32, _outcome: usize) -> ChanceEdge<'_> {
            unreachable!("no chance nodes")
        }
        fn terminal_utility(&self, _node: u32, _hero: u8, _opp_reach: &[f32], _out: &mut [f32]) {
            unreachable!("never solved")
        }
        fn normalizer(&self) -> f32 {
            1.0
        }
        fn root_pot(&self) -> f32 {
            1.0
        }
    }

    /// REGRESSION. `offsets[node] = total as u32` used to truncate silently once the tree
    /// needed more than `u32::MAX` entries, aliasing two nodes onto one region — and
    /// `u32::MAX` is also the non-decision sentinel, so the very last addressable offset
    /// is poisoned too. Such a solve is invalid either way; it has to fail loudly at
    /// build time.
    #[test]
    #[should_panic(expected = "exceed the 4294967294 a u32 offset can address")]
    fn a_tree_past_the_u32_offset_limit_fails_at_build() {
        Solver::new(TooBigForU32Offsets);
    }

    #[test]
    fn chance_edges_compact_and_expand_correctly() {
        let mut s = Solver::new(PublicCard::new());
        s.run(2_000, &DcfrParams::default(), 500, |i, chips, pct| {
            println!("public-card iter {i:>5}  exploitability {chips:.9} chips  {pct:.6}% of pot");
        });
        let e = s.exploitability();
        println!("public-card final {:?}", e);
        assert!(e.chips < 1e-4, "exploitability {}", e.chips);

        let v0 = s.expected_value(0);
        let v1 = s.expected_value(1);
        println!("public-card value: p0 {v0:.6}  p1 {v1:.6}");
        assert!((v0 - 0.25).abs() < 1e-3, "player 0 value {v0} != 0.25");
        assert!((v0 + v1).abs() < 1e-5, "values {v0} + {v1} are not zero-sum");

        // Fold the lower survivor, show down the higher, in all three subgames.
        for p in 0..3u32 {
            let st = s.average_strategy(1 + p);
            println!("public-card p={p} strategy fold {:?} show {:?}", &st[..2], &st[2..]);
            assert!(st[0] > 0.99, "should fold the low survivor at p={p}");
            assert!(st[3] > 0.99, "should show down the high survivor at p={p}");
        }
    }
}
