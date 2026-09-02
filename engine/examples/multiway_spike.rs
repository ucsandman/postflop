//! Stage 3 multiway spike. SCRATCH. Ships nothing, touches no production path.
//!
//! Run with: `cargo run -p engine --release --example multiway_spike`
//!
//! Question: does a three-range showdown terminal admit an O(52*(N+M+K)) form
//! the way the two-range one admits O(N+M), and what does the constant cost?
//!
//! # What is being tested
//! Hero (seat 0) faces two opponents B (seat 1) and C (seat 2). The pot is a
//! list of layers, each with an eligible seat set - one main pot plus one side
//! pot is the shortest thing that exercises side-pot layering. Hero's payoff is
//!
//! ```text
//! EV(h) = sum over (b, c) pairwise card-disjoint of  wB(b) * wC(c) * (award(h,b,c) - stake)
//! ```
//!
//! The naive reference is the obviously-correct O(N*M*K) triple loop.
//!
//! # The derived fast form
//! Hero's award from any layer hero is eligible for depends only on how hero's
//! rank compares to each opponent's - never on how the two opponents compare to
//! each other. So the payoff is a linear functional of the 3x3 matrix
//!
//! ```text
//! X[i][j] = sum of wB(b)*wC(c) over b in class i of B, c in class j of C,
//!           with b, c disjoint from hero and from each other
//! ```
//!
//! where class in {below hero's rank, tied with it, above it}. The classes are
//! running prefix sums over each opponent's rank-sorted hands, exactly as in
//! `terminal::showdown_ev_ranked`. The part that does NOT factorise is
//! opponent-vs-opponent card removal:
//!
//! ```text
//! X[i][j] = D_B[i]*D_C[j]  -  sum over cards x of  beta_B[i][x]*beta_C[j][x]
//!                          +  Same[i][j]
//! ```
//!
//! * `D_B[i]` - reach of B's class-i hands disjoint from hero. The existing
//!   52-accumulator inclusion-exclusion: `tot - card[a] - card[b] + combo[ab]`.
//! * `beta_B[i][x]` - reach of B's class-i hands that contain card `x` and are
//!   disjoint from hero: `card[x] - combo[xa] - combo[xb]`.
//! * The card sum counts a pair sharing one card once and a pair sharing two
//!   cards (identical combos) twice, so the double-counted identical-combo mass
//!   is added back. That is `Same[i][j]`, and it is zero unless `i == j`: a
//!   combo has one rank on one board, so a combo held by both opponents falls
//!   in the same class on both sides. It is therefore a third running prefix
//!   sum, over the combos the two opponent lists share, carrying the product
//!   `wB(q)*wC(q)`, with the same `tot - card[a] - card[b] + combo[ab]` shape.
//!
//! Unpublished and unverified: the oracle is the point.
//!
//! # Gates
//! 1. fast == naive on 200+ random reduced-deck cases including ties and a
//!    side-pot layer.
//! 2. measured constant within 2x of ~52x the two-way sweep.
//! 3. negative control A: drop the overlap sum -> red.
//! 4. negative control B: drop the same-combo term -> red, and differently.

use engine::cards::{Card, NUM_CARDS};
use engine::range::{combo_index, NUM_COMBOS};
use engine::terminal::{hand_rank, showdown_ev_ranked, Hand, SortedRanks};
use std::time::Instant;

// ---------------------------------------------------------------------------
// Payoff specification (shared by naive and fast: it is the spec, not the
// thing under test - what is under test is the pair summation)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Layer {
    amount: f64,
    /// Seats still eligible for this layer. Seat 0 is hero.
    eligible: [bool; 3],
}

/// Hero's total award across every layer, given the three 7-card ranks.
fn hero_award(layers: &[Layer], r: [u32; 3]) -> f64 {
    let mut got = 0.0;
    for l in layers {
        if !l.eligible[0] {
            continue;
        }
        let mut mx = 0u32;
        for (&e, &ri) in l.eligible.iter().zip(r.iter()) {
            if e && ri > mx {
                mx = ri;
            }
        }
        if r[0] != mx {
            continue;
        }
        let winners = (0..3).filter(|&i| l.eligible[i] && r[i] == mx).count();
        got += l.amount / winners as f64;
    }
    got
}

#[inline]
fn shares(a: Hand, b: Hand) -> bool {
    a.0 == b.0 || a.0 == b.1 || a.1 == b.0 || a.1 == b.1
}

// ---------------------------------------------------------------------------
// Naive O(N*M*K) reference
// ---------------------------------------------------------------------------

struct Counts {
    triples: u64,
    chop3: u64,
    chop2: u64,
}

#[allow(clippy::too_many_arguments)]
fn naive(
    board: &[Card; 5],
    hero: &[Hand],
    vb: &[Hand],
    wb: &[f64],
    vc: &[Hand],
    wc: &[f64],
    layers: &[Layer],
    stake: f64,
    out: &mut [f64],
) -> Counts {
    let hr: Vec<u32> = hero.iter().map(|&h| hand_rank(board, h)).collect();
    let br: Vec<u32> = vb.iter().map(|&h| hand_rank(board, h)).collect();
    let cr: Vec<u32> = vc.iter().map(|&h| hand_rank(board, h)).collect();
    let mut n = Counts { triples: 0, chop3: 0, chop2: 0 };

    for i in 0..hero.len() {
        let h = hero[i];
        let mut ev = 0.0f64;
        for j in 0..vb.len() {
            if shares(h, vb[j]) {
                continue;
            }
            for k in 0..vc.len() {
                if shares(h, vc[k]) || shares(vb[j], vc[k]) {
                    continue;
                }
                let w = wb[j] * wc[k];
                let r = [hr[i], br[j], cr[k]];
                ev += w * (hero_award(layers, r) - stake);
                n.triples += 1;
                if r[0] == r[1] && r[1] == r[2] {
                    n.chop3 += 1;
                } else if r[0] == r[1] || r[0] == r[2] {
                    n.chop2 += 1;
                }
            }
        }
        out[i] = ev;
    }
    n
}

// ---------------------------------------------------------------------------
// Fast form
// ---------------------------------------------------------------------------

const ALL: usize = 0;
const BEL: usize = 1;
const TIE: usize = 2;

/// One weighted, ranked entry: an opponent hand, or a shared combo carrying the
/// product of the two sides' reaches.
#[derive(Clone, Copy)]
struct Item {
    c0: usize,
    c1: usize,
    ci: usize,
    w: f64,
    r: u32,
}

/// Running prefix accumulator over one rank-sorted item list.
///
/// Lane `ALL` is the whole list (static). Lane `BEL` grows monotonically as the
/// hero sweep advances. Lane `TIE` holds only the current hero rank's group and
/// is unwound by assignment, never subtraction. `above = ALL - BEL - TIE`.
struct Acc {
    tot: [f64; 3],
    card: Vec<[f64; 3]>,
    combo: Vec<[f64; 3]>,
    items: Vec<Item>,
    cur: usize,
    tie_lo: usize,
    tie_hi: usize,
}

impl Acc {
    fn new(mut items: Vec<Item>) -> Acc {
        items.sort_by_key(|it| it.r);
        Acc {
            tot: [0.0; 3],
            card: vec![[0.0; 3]; NUM_CARDS],
            combo: vec![[0.0; 3]; NUM_COMBOS],
            items,
            cur: 0,
            tie_lo: 0,
            tie_hi: 0,
        }
    }

    fn reset(&mut self) {
        for v in self.card.iter_mut() {
            *v = [0.0; 3];
        }
        for v in self.combo.iter_mut() {
            *v = [0.0; 3];
        }
        self.tot = [0.0; 3];
        for k in 0..self.items.len() {
            let it = self.items[k];
            self.tot[ALL] += it.w;
            self.card[it.c0][ALL] += it.w;
            self.card[it.c1][ALL] += it.w;
            self.combo[it.ci][ALL] += it.w;
        }
        self.cur = 0;
        self.tie_lo = 0;
        self.tie_hi = 0;
    }

    /// Absorb everything below `r` into BEL (the previous tie group flows
    /// through here), then build the equal-rank group into TIE.
    fn advance(&mut self, r: u32) {
        while self.cur < self.items.len() && self.items[self.cur].r < r {
            let it = self.items[self.cur];
            self.tot[BEL] += it.w;
            self.card[it.c0][BEL] += it.w;
            self.card[it.c1][BEL] += it.w;
            self.combo[it.ci][BEL] += it.w;
            self.cur += 1;
        }
        self.tie_lo = self.cur;
        let mut j = self.cur;
        while j < self.items.len() && self.items[j].r == r {
            let it = self.items[j];
            self.tot[TIE] += it.w;
            self.card[it.c0][TIE] += it.w;
            self.card[it.c1][TIE] += it.w;
            self.combo[it.ci][TIE] += it.w;
            j += 1;
        }
        self.tie_hi = j;
    }

    fn clear_tie(&mut self) {
        for k in self.tie_lo..self.tie_hi {
            let it = self.items[k];
            self.card[it.c0][TIE] = 0.0;
            self.card[it.c1][TIE] = 0.0;
            self.combo[it.ci][TIE] = 0.0;
        }
        self.tot[TIE] = 0.0;
    }
}

/// `[ALL, BEL, TIE]` lanes -> `[below, tie, above]` class values.
#[inline(always)]
fn classes(v: [f64; 3]) -> [f64; 3] {
    [v[BEL], v[TIE], v[ALL] - v[BEL] - v[TIE]]
}

#[derive(Clone, Copy, PartialEq)]
enum Sabotage {
    None,
    /// Negative control A: opponent-vs-opponent overlap dropped.
    NoOverlap,
    /// Negative control B: the shared-combo (double-counted) add-back dropped.
    NoSameCombo,
}

struct Fast {
    b: Acc,
    c: Acc,
    /// Shared combos between B and C, weight = product of the two reaches.
    s: Acc,
    /// `rows[card][x] = combo_index(card, x)`; the diagonal is never read.
    rows: Vec<u32>,
    live_cards: Vec<usize>,
}

impl Fast {
    fn new(b: Vec<Item>, c: Vec<Item>, s: Vec<Item>) -> Fast {
        let mut rows = vec![0u32; NUM_CARDS * NUM_CARDS];
        for a in 0..NUM_CARDS {
            for x in 0..NUM_CARDS {
                if a != x {
                    rows[a * NUM_CARDS + x] = combo_index(a as Card, x as Card) as u32;
                }
            }
        }
        Fast {
            b: Acc::new(b),
            c: Acc::new(c),
            s: Acc::new(s),
            rows,
            live_cards: Vec::with_capacity(NUM_CARDS),
        }
    }

    /// `hero` must be ascending by rank; `out` is written in the caller's order.
    fn run(
        &mut self,
        hero: &[(usize, Hand, u32)],
        coef: &[[f64; 3]; 3],
        sab: Sabotage,
        out: &mut [f64],
    ) {
        self.b.reset();
        self.c.reset();
        self.s.reset();

        // Only cards held by both opponents can carry overlap mass.
        self.live_cards.clear();
        for x in 0..NUM_CARDS {
            if self.b.card[x][ALL] != 0.0 && self.c.card[x][ALL] != 0.0 {
                self.live_cards.push(x);
            }
        }

        let n = hero.len();
        let mut hi = 0usize;
        while hi < n {
            let r = hero[hi].2;
            let mut hj = hi + 1;
            while hj < n && hero[hj].2 == r {
                hj += 1;
            }
            self.b.advance(r);
            self.c.advance(r);
            self.s.advance(r);

            for &(idx, h, _) in &hero[hi..hj] {
                let (a, bb) = (h.0 as usize, h.1 as usize);
                let iab = self.rows[a * NUM_CARDS + bb] as usize;

                let db = classes(add3(
                    sub3(sub3(self.b.tot, self.b.card[a]), self.b.card[bb]),
                    self.b.combo[iab],
                ));
                let dc = classes(add3(
                    sub3(sub3(self.c.tot, self.c.card[a]), self.c.card[bb]),
                    self.c.combo[iab],
                ));
                let same = classes(add3(
                    sub3(sub3(self.s.tot, self.s.card[a]), self.s.card[bb]),
                    self.s.combo[iab],
                ));

                let mut ov = [[0.0f64; 3]; 3];
                if sab != Sabotage::NoOverlap {
                    let (ra, rb) = (a * NUM_CARDS, bb * NUM_CARDS);
                    for &x in &self.live_cards {
                        if x == a || x == bb {
                            continue;
                        }
                        let (ia, ib) = (self.rows[ra + x] as usize, self.rows[rb + x] as usize);
                        let bl = classes(sub3(
                            sub3(self.b.card[x], self.b.combo[ia]),
                            self.b.combo[ib],
                        ));
                        let cl = classes(sub3(
                            sub3(self.c.card[x], self.c.combo[ia]),
                            self.c.combo[ib],
                        ));
                        for i in 0..3 {
                            for j in 0..3 {
                                ov[i][j] += bl[i] * cl[j];
                            }
                        }
                    }
                }

                let mut ev = 0.0f64;
                for i in 0..3 {
                    for j in 0..3 {
                        let mut x = db[i] * dc[j] - ov[i][j];
                        if i == j && sab != Sabotage::NoSameCombo {
                            x += same[i];
                        }
                        ev += coef[i][j] * x;
                    }
                }
                out[idx] = ev;
            }

            self.b.clear_tie();
            self.c.clear_tie();
            self.s.clear_tie();
            hi = hj;
        }
    }
}

#[inline(always)]
fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline(always)]
fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/// The 3x3 payoff table, from the same award spec on synthetic ranks: hero 1,
/// opponent 0 / 1 / 2 for below / tied / above. Valid because hero's share of
/// any layer hero is eligible for never depends on how the two opponents
/// compare to each other.
fn coef_table(layers: &[Layer], stake: f64) -> [[f64; 3]; 3] {
    let mut t = [[0.0f64; 3]; 3];
    for (i, row) in t.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = hero_award(layers, [1, i as u32, j as u32]) - stake;
        }
    }
    t
}

fn build_items(hands: &[Hand], w: &[f64], board: &[Card; 5]) -> Vec<Item> {
    hands
        .iter()
        .zip(w)
        .map(|(&h, &w)| Item {
            c0: h.0 as usize,
            c1: h.1 as usize,
            ci: combo_index(h.0, h.1),
            w,
            r: hand_rank(board, h),
        })
        .collect()
}

/// Combos held by both opponents, carrying the product of the two reaches.
fn shared_items(
    vb: &[Hand],
    wb: &[f64],
    vc: &[Hand],
    wc: &[f64],
    board: &[Card; 5],
) -> Vec<Item> {
    let mut cw = vec![0.0f64; NUM_COMBOS];
    let mut have = vec![false; NUM_COMBOS];
    for (&h, &w) in vc.iter().zip(wc) {
        let i = combo_index(h.0, h.1);
        cw[i] += w;
        have[i] = true;
    }
    let mut out = Vec::new();
    for (&h, &w) in vb.iter().zip(wb) {
        let i = combo_index(h.0, h.1);
        if have[i] {
            out.push(Item {
                c0: h.0 as usize,
                c1: h.1 as usize,
                ci: i,
                w: w * cw[i],
                r: hand_rank(board, h),
            });
        }
    }
    out
}

fn sorted_hero(hero: &[Hand], board: &[Card; 5]) -> Vec<(usize, Hand, u32)> {
    let mut v: Vec<(usize, Hand, u32)> = hero
        .iter()
        .enumerate()
        .map(|(i, &h)| (i, h, hand_rank(board, h)))
        .collect();
    v.sort_by_key(|t| t.2);
    v
}

// ---------------------------------------------------------------------------
// Case generation on a reduced deck
// ---------------------------------------------------------------------------

fn xorshift(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

fn pick(state: &mut u64, n: usize) -> usize {
    (xorshift(state) % n as u64) as usize
}

fn unit(state: &mut u64) -> f64 {
    (xorshift(state) % 1_000_001) as f64 / 1_000_000.0
}

struct Case {
    board: [Card; 5],
    hero: Vec<Hand>,
    vb: Vec<Hand>,
    wb: Vec<f64>,
    vc: Vec<Hand>,
    wc: Vec<f64>,
    layers: Vec<Layer>,
    stake: f64,
    pool: usize,
    tie_groups: usize,
    max_tie: usize,
}

/// A reduced deck of 12-16 cards. Three modes, so ties are common rather than
/// incidental: mode 1 draws every card from four ranks, mode 2 puts a royal on
/// the board so the board plays and every hand ties.
fn gen_case(state: &mut u64, case: usize) -> Case {
    let mode = case % 3;
    let mut deck: Vec<Card> = Vec::new();
    match mode {
        1 => {
            // All four suits of four random distinct ranks: 16 cards, heavy ties.
            let mut ranks: Vec<u8> = (0..13).collect();
            for i in 0..4 {
                let j = i + pick(state, 13 - i);
                ranks.swap(i, j);
            }
            for &r in &ranks[..4] {
                for s in 0..4 {
                    deck.push(r * 4 + s);
                }
            }
        }
        2 => {
            // Royal flush board plus a random tail: every 7-card hand is that
            // royal, so the whole field is one tie group.
            for r in 8..13 {
                deck.push(r * 4 + 3); // Ts Js Qs Ks As
            }
            let mut rest: Vec<Card> = (0..52).filter(|c| !deck.contains(c)).collect();
            for i in 0..9 {
                let j = i + pick(state, rest.len() - i);
                rest.swap(i, j);
            }
            deck.extend_from_slice(&rest[..9]);
        }
        _ => {
            let mut all: Vec<Card> = (0..52).collect();
            let k = 12 + pick(state, 5);
            for i in 0..k {
                let j = i + pick(state, 52 - i);
                all.swap(i, j);
            }
            deck.extend_from_slice(&all[..k]);
        }
    }

    // Board: for mode 2 the royal is deck[0..5] by construction, else shuffle.
    if mode != 2 {
        for i in 0..5 {
            let j = i + pick(state, deck.len() - i);
            deck.swap(i, j);
        }
    }
    let board = [deck[0], deck[1], deck[2], deck[3], deck[4]];
    let rest: Vec<Card> = deck[5..].to_vec();

    let mut pool: Vec<Hand> = Vec::new();
    for i in 0..rest.len() {
        for j in i + 1..rest.len() {
            pool.push((rest[i], rest[j]));
        }
    }

    let mut ranks: Vec<u32> = pool.iter().map(|&h| hand_rank(&board, h)).collect();
    ranks.sort_unstable();
    let mut tie_groups = 0;
    let mut max_tie = 0;
    let mut i = 0;
    while i < ranks.len() {
        let mut j = i + 1;
        while j < ranks.len() && ranks[j] == ranks[i] {
            j += 1;
        }
        if j - i > 1 {
            tie_groups += 1;
        }
        max_tie = max_tie.max(j - i);
        i = j;
    }

    let subset = |state: &mut u64, pool: &[Hand]| -> Vec<Hand> {
        let mut p = pool.to_vec();
        for i in 0..p.len() {
            let j = i + pick(state, p.len() - i);
            p.swap(i, j);
        }
        // Biased wide: card removal on an 11-card remaining deck kills most
        // triples, so narrow ranges would leave the gate almost no volume.
        let half = p.len() / 2;
        let k = 1 + half + pick(state, p.len() - half);
        p.truncate(k);
        p
    };

    let hero = subset(state, &pool);
    let vb = subset(state, &pool);
    let vc = subset(state, &pool);
    // Some zero weights, so blocked and dead combos both occur.
    let wb: Vec<f64> = (0..vb.len())
        .map(|_| if pick(state, 8) == 0 { 0.0 } else { unit(state) })
        .collect();
    let wc: Vec<f64> = (0..vc.len())
        .map(|_| if pick(state, 8) == 0 { 0.0 } else { unit(state) })
        .collect();

    // One main pot plus one side-pot layer. Rotate which seat is the short
    // all-in, so hero is sometimes eligible for the side pot and sometimes not.
    let main = 30.0 + unit(state) * 90.0;
    let side = 10.0 + unit(state) * 60.0;
    let short = case % 3;
    let mut elig = [true; 3];
    elig[short] = false;
    let layers = vec![
        Layer { amount: main, eligible: [true; 3] },
        Layer { amount: side, eligible: elig },
    ];
    let stake = 5.0 + unit(state) * 25.0;

    Case {
        board,
        hero,
        vb,
        wb,
        vc,
        wc,
        layers,
        stake,
        pool: pool.len(),
        tie_groups,
        max_tie,
    }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

struct Deviation {
    max_abs: f64,
    max_rel: f64,
    combos: usize,
}

fn compare(fast: &[f64], want: &[f64]) -> Deviation {
    let mut d = Deviation { max_abs: 0.0, max_rel: 0.0, combos: fast.len() };
    for (&g, &w) in fast.iter().zip(want) {
        let a = (g - w).abs();
        if a > d.max_abs {
            d.max_abs = a;
        }
        let rel = a / w.abs().max(1.0);
        if rel > d.max_rel {
            d.max_rel = rel;
        }
    }
    d
}

fn oracle_gate(cases: usize) -> bool {
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let (mut triples, mut chop3, mut chop2) = (0u64, 0u64, 0u64);
    let (mut widest, mut layers_seen, mut tie_groups, mut max_tie) = (0usize, 0usize, 0u64, 0usize);
    let mut widest_pool = 0usize;
    let mut worst = Deviation { max_abs: 0.0, max_rel: 0.0, combos: 0 };
    let mut worst_case = 0usize;
    let mut sab_a_min_abs = f64::INFINITY;
    let mut sab_b_min_abs = f64::INFINITY;
    let mut sab_a_caught = 0usize;
    let mut sab_b_caught = 0usize;
    let mut side_pots_with_hero = 0usize;
    let mut ok = true;

    for case in 0..cases {
        let c = gen_case(&mut state, case);
        widest = widest.max(c.hero.len().max(c.vb.len()).max(c.vc.len()));
        widest_pool = widest_pool.max(c.pool);
        layers_seen += c.layers.len();
        tie_groups += c.tie_groups as u64;
        max_tie = max_tie.max(c.max_tie);
        if c.layers[1].eligible[0] {
            side_pots_with_hero += 1;
        }

        let mut want = vec![0.0f64; c.hero.len()];
        let n = naive(
            &c.board, &c.hero, &c.vb, &c.wb, &c.vc, &c.wc, &c.layers, c.stake, &mut want,
        );
        triples += n.triples;
        chop3 += n.chop3;
        chop2 += n.chop2;

        let mut f = Fast::new(
            build_items(&c.vb, &c.wb, &c.board),
            build_items(&c.vc, &c.wc, &c.board),
            shared_items(&c.vb, &c.wb, &c.vc, &c.wc, &c.board),
        );
        let hs = sorted_hero(&c.hero, &c.board);
        let coef = coef_table(&c.layers, c.stake);

        let mut got = vec![0.0f64; c.hero.len()];
        f.run(&hs, &coef, Sabotage::None, &mut got);
        let d = compare(&got, &want);
        if d.max_rel > worst.max_rel {
            worst = d;
            worst_case = case;
        }
        if worst.max_rel > 1e-9 {
            eprintln!(
                "FAIL case {case}: max_abs={:.6e} max_rel={:.6e} hero={} B={} C={}",
                worst.max_abs,
                worst.max_rel,
                c.hero.len(),
                c.vb.len(),
                c.vc.len()
            );
            ok = false;
            break;
        }

        // Negative controls, run on every case.
        let mut sa = vec![0.0f64; c.hero.len()];
        f.run(&hs, &coef, Sabotage::NoOverlap, &mut sa);
        let da = compare(&sa, &want);
        if da.max_rel > 1e-9 {
            sab_a_caught += 1;
            sab_a_min_abs = sab_a_min_abs.min(da.max_abs);
        }
        let mut sb = vec![0.0f64; c.hero.len()];
        f.run(&hs, &coef, Sabotage::NoSameCombo, &mut sb);
        let db = compare(&sb, &want);
        if db.max_rel > 1e-9 {
            sab_b_caught += 1;
            sab_b_min_abs = sab_b_min_abs.min(db.max_abs);
        }
    }

    println!(
        "gate 1 oracle: cases={cases} triples_evaluated={triples} widest_range={widest} \
         widest_deck_pool={widest_pool} layers={layers_seen} \
         side_pots_hero_eligible={side_pots_with_hero} \
         tie_groups={tie_groups} max_tie_group={max_tie} \
         three_way_chops={chop3} two_way_chops={chop2}"
    );
    println!(
        "gate 1 result: {} worst max_rel={:.3e} (case {worst_case}, {} hero combos), max_abs={:.3e}",
        if ok { "PASS" } else { "FAIL" },
        worst.max_rel,
        worst.combos,
        worst.max_abs
    );
    println!(
        "gate 3 control A (overlap term deleted): red on {sab_a_caught}/{cases} cases, \
         smallest divergence max_abs={:.4e}",
        sab_a_min_abs
    );
    println!(
        "gate 4 control B (same-combo term deleted): red on {sab_b_caught}/{cases} cases, \
         smallest divergence max_abs={:.4e}",
        sab_b_min_abs
    );
    // The controls are "red" in the sense that matters: with either term
    // deleted the gate above fails outright. A handful of degenerate cases
    // (a one-combo opponent list, an all-zero reach vector) have no overlap
    // mass to lose, which is why neither count is 210/210.
    ok && sab_a_caught > 0 && sab_b_caught > 0
}

/// Full 52-card deck, full-width ranges: 3-way fast sweep vs the production
/// 2-way sweep. Both timed regions exclude `eval7` and the rank sort and
/// include their own reach accumulation.
fn constant_gate() -> f64 {
    let board: [Card; 5] = [51, 47, 43, 39, 34]; // As Ks Qs Js Th - not a made board for anyone
    let mut hands: Vec<Hand> = Vec::new();
    for a in 0..NUM_CARDS as Card {
        for b in a + 1..NUM_CARDS as Card {
            if board.contains(&a) || board.contains(&b) {
                continue;
            }
            hands.push((a, b));
        }
    }
    let n = hands.len();
    let mut state = 0xDEAD_BEEF_CAFE_F00Du64;
    let w: Vec<f64> = (0..n).map(|_| unit(&mut state)).collect();
    let wf: Vec<f32> = w.iter().map(|&x| x as f32).collect();

    let layers = vec![
        Layer { amount: 100.0, eligible: [true; 3] },
        Layer { amount: 40.0, eligible: [true, true, false] },
    ];
    let coef = coef_table(&layers, 12.0);

    let mut f = Fast::new(
        build_items(&hands, &w, &board),
        build_items(&hands, &w, &board),
        shared_items(&hands, &w, &hands, &w, &board),
    );
    let hs = sorted_hero(&hands, &board);
    let mut out3 = vec![0.0f64; n];

    let hr = SortedRanks::new(&board, &hands);
    let vr = SortedRanks::new(&board, &hands);
    let mut out2 = vec![0.0f32; n];

    const REPS3: usize = 20;
    const REPS2: usize = 2000;

    // Warm both paths before timing.
    f.run(&hs, &coef, Sabotage::None, &mut out3);
    showdown_ev_ranked(&hands, &hr, &hands, &vr, &wf, 50.0, -50.0, 0.0, &mut out2);

    // Checksums, black-boxed, so neither timed loop can be optimised away.
    let (mut k3, mut k2) = (0.0f64, 0.0f32);
    let t3 = Instant::now();
    for _ in 0..REPS3 {
        f.run(&hs, &coef, Sabotage::None, &mut out3);
        k3 += std::hint::black_box(&out3)[7];
    }
    let s3 = t3.elapsed().as_secs_f64() / REPS3 as f64;

    let t2 = Instant::now();
    for _ in 0..REPS2 {
        showdown_ev_ranked(&hands, &hr, &hands, &vr, &wf, 50.0, -50.0, 0.0, &mut out2);
        k2 += std::hint::black_box(&out2)[7];
    }
    let s2 = t2.elapsed().as_secs_f64() / REPS2 as f64;
    assert!(k3 != 0.0 && k2 != 0.0, "timed loops produced nothing: {k3} {k2}");

    let ratio = s3 / s2;
    println!(
        "gate 2 constant: board={:?} combos_per_range={n} live_cards_swept={} \
         two_way={:.4}ms three_way={:.4}ms ratio={:.1}x  \
         (per hero combo: 2-way {:.1}ns, 3-way {:.1}ns)  checksums={:.4}/{:.4}",
        board,
        f.live_cards.len(),
        s2 * 1e3,
        s3 * 1e3,
        ratio,
        s2 * 1e9 / n as f64,
        s3 * 1e9 / n as f64,
        k3,
        k2
    );
    ratio
}

/// Revert-to-red for gate 2: the same three ranges, same board, same payoff,
/// run through the naive O(N*M*K) loop. Narrow enough that the naive finishes;
/// the point is the ratio the gate is supposed to reject.
fn constant_gate_red(width: usize) -> (f64, f64) {
    let board: [Card; 5] = [51, 47, 43, 39, 34];
    let mut hands: Vec<Hand> = Vec::new();
    for a in 0..NUM_CARDS as Card {
        for b in a + 1..NUM_CARDS as Card {
            if board.contains(&a) || board.contains(&b) {
                continue;
            }
            hands.push((a, b));
        }
    }
    let mut state = 0x1234_5678_9ABC_DEF0u64;
    for i in 0..width {
        let j = i + pick(&mut state, hands.len() - i);
        hands.swap(i, j);
    }
    hands.truncate(width);
    let n = hands.len();
    let w: Vec<f64> = (0..n).map(|_| unit(&mut state)).collect();
    let wf: Vec<f32> = w.iter().map(|&x| x as f32).collect();

    let layers = vec![
        Layer { amount: 100.0, eligible: [true; 3] },
        Layer { amount: 40.0, eligible: [true, true, false] },
    ];
    let coef = coef_table(&layers, 12.0);
    let mut f = Fast::new(
        build_items(&hands, &w, &board),
        build_items(&hands, &w, &board),
        shared_items(&hands, &w, &hands, &w, &board),
    );
    let hs = sorted_hero(&hands, &board);
    let hr = SortedRanks::new(&board, &hands);
    let mut out_f = vec![0.0f64; n];
    let mut out_n = vec![0.0f64; n];
    let mut out2 = vec![0.0f32; n];

    f.run(&hs, &coef, Sabotage::None, &mut out_f);
    let counts = naive(&board, &hands, &hands, &w, &hands, &w, &layers, 12.0, &mut out_n);
    let d = compare(&out_f, &out_n);
    assert!(d.max_rel <= 1e-9, "width-{width} fast/naive disagree: {:.3e}", d.max_rel);

    let t2 = Instant::now();
    for _ in 0..2000 {
        showdown_ev_ranked(&hands, &hr, &hands, &hr, &wf, 50.0, -50.0, 0.0, &mut out2);
        std::hint::black_box(&out2);
    }
    let s2 = t2.elapsed().as_secs_f64() / 2000.0;

    let tf = Instant::now();
    for _ in 0..200 {
        f.run(&hs, &coef, Sabotage::None, &mut out_f);
        std::hint::black_box(&out_f);
    }
    let sf = tf.elapsed().as_secs_f64() / 200.0;

    let tn = Instant::now();
    for _ in 0..5 {
        naive(&board, &hands, &hands, &w, &hands, &w, &layers, 12.0, &mut out_n);
        std::hint::black_box(&out_n);
    }
    let sn = tn.elapsed().as_secs_f64() / 5.0;

    println!(
        "gate 2 red control: width={width} triples={} two_way={:.4}ms fast3={:.4}ms \
         naive3={:.3}ms  fast/2way={:.1}x  naive/2way={:.0}x",
        counts.triples,
        s2 * 1e3,
        sf * 1e3,
        sn * 1e3,
        sf / s2,
        sn / s2
    );
    (sf / s2, sn / s2)
}

fn main() {
    println!("Stage 3 multiway spike - scratch, ships nothing\n");

    let cases = 210usize;
    let g1 = oracle_gate(cases);
    println!();
    let ratio = constant_gate();
    let (red_fast, red_naive) = constant_gate_red(120);
    let g2 = ratio <= 104.0;
    assert!(
        red_naive > 104.0 && red_fast <= 104.0,
        "gate 2 does not discriminate: fast={red_fast:.1}x naive={red_naive:.1}x"
    );

    println!();
    println!(
        "GO/NO-GO: oracle={} constant={} ({:.1}x vs the 2-way sweep, gate is <=104x)",
        if g1 { "PASS" } else { "FAIL" },
        if g2 { "PASS" } else { "FAIL" },
        ratio
    );
    if !g1 {
        std::process::exit(1);
    }
}
