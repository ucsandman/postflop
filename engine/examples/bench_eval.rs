//! Throughput benchmark for the 7-card evaluator.
//!
//! Run with: `cargo run -p engine --release --example bench_eval`
//!
//! Hands are precomputed into a flat pool first so the timed loop measures
//! `eval7` and nothing else. The PRNG is a deterministic xorshift so the pool
//! is identical between runs (and needs no dependency).

use engine::cards::Card;
use engine::evaluator::eval7;
use std::hint::black_box;
use std::time::Instant;

const HANDS: usize = 10_000_000;
const PASSES: usize = 3;

fn xorshift(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

fn main() {
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut deck: [Card; 52] = std::array::from_fn(|i| i as u8);

    let build = Instant::now();
    let mut hands: Vec<[Card; 7]> = Vec::with_capacity(HANDS);
    for _ in 0..HANDS {
        // Partial Fisher-Yates: seven swaps leave the deck a valid permutation,
        // so every hand holds seven distinct cards.
        let mut hand = [0u8; 7];
        for i in 0..7 {
            let j = i + (xorshift(&mut state) % (52 - i as u64)) as usize;
            deck.swap(i, j);
            hand[i] = deck[i];
        }
        hands.push(hand);
    }
    println!(
        "prepared {} hands ({:.0} MiB) in {:.2?}",
        hands.len(),
        (hands.len() * 7) as f64 / (1024.0 * 1024.0),
        build.elapsed()
    );

    let mut best_rate = 0.0f64;
    for pass in 1..=PASSES {
        let start = Instant::now();
        let mut acc = 0u64;
        for hand in &hands {
            acc = acc.wrapping_add(black_box(eval7(black_box(hand))) as u64);
        }
        let elapsed = start.elapsed();
        let rate = hands.len() as f64 / elapsed.as_secs_f64();
        best_rate = best_rate.max(rate);
        println!(
            "pass {pass}: {:.3?}  {:.2} M evals/sec  (checksum {})",
            elapsed,
            rate / 1e6,
            black_box(acc)
        );
    }
    println!("best: {:.2} M evals/sec", best_rate / 1e6);
}
