//! Real-binary integration test: runs the actual `solver` executable end to end
//! (`solve` then `show`) via `std::process::Command`, not in-process function
//! calls, and asserts on exit codes and real stdout.

use std::path::PathBuf;
use std::process::Command;

use engine::solution::{ActionLabelData, Solution};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_solver"))
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/river.toml")
}

fn offsuit_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/offsuit.toml")
}

/// Pulls one cell's text out of a `show` rank-grid by rank label (e.g. `'A'`,
/// `'4'`), independent of which row/column it lands in. Tied to the grid's
/// documented shape (a 5-char row-label gutter, 9-char right-aligned cells) —
/// a panic here means the output format changed, not a false pass.
fn grid_cell(stdout: &str, row_label: char, col_label: char) -> String {
    const COL_WIDTH: usize = 9;
    let lines: Vec<&str> = stdout.lines().collect();
    let header_idx = lines
        .iter()
        .position(|l| l.starts_with("     ") && l.len() > 5)
        .expect("grid header line not found");
    let header = lines[header_idx].as_bytes();
    let col = (0..13)
        .find(|&c| {
            let start = 5 + c * COL_WIDTH;
            std::str::from_utf8(&header[start..start + COL_WIDTH]).unwrap().trim().chars().next()
                == Some(col_label)
        })
        .expect("column label not found in grid header");

    for line in &lines[header_idx + 1..] {
        let bytes = line.as_bytes();
        if bytes.len() < 5 + 13 * COL_WIDTH {
            continue;
        }
        let label = std::str::from_utf8(&bytes[0..4]).unwrap().trim();
        if label.len() == 1 && label.chars().next() == Some(row_label) {
            let start = 5 + col * COL_WIDTH;
            return std::str::from_utf8(&bytes[start..start + COL_WIDTH]).unwrap().trim().to_string();
        }
    }
    panic!("row label {row_label:?} not found in grid:\n{stdout}");
}

#[test]
fn solve_then_show_end_to_end() {
    let dir = std::env::temp_dir().join(format!("solver_cli_test_{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let out = dir.join("solution.json");

    let solve = bin()
        .args([
            "solve",
            "--config",
            fixture().to_str().unwrap(),
            "--report-every",
            "50",
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .expect("run solve");
    let solve_stdout = String::from_utf8_lossy(&solve.stdout);
    let solve_stderr = String::from_utf8_lossy(&solve.stderr);
    assert!(
        solve.status.success(),
        "solve exited {:?}\nstdout:\n{solve_stdout}\nstderr:\n{solve_stderr}",
        solve.status.code()
    );
    assert!(solve_stdout.contains("decision"), "expected tree stats: {solve_stdout}");
    assert!(
        solve_stdout.contains("[measured]"),
        "exploitability figures must be labeled measured: {solve_stdout}"
    );
    assert!(
        solve_stdout.contains("=== final report ==="),
        "missing final report: {solve_stdout}"
    );
    assert!(solve_stdout.contains("OOP EV"), "missing OOP EV line: {solve_stdout}");
    assert!(out.exists(), "solution file was not written to {out:?}");

    let show = bin()
        .args([
            "show",
            "--solution",
            out.to_str().unwrap(),
            "--line",
            "check,bet:100",
        ])
        .output()
        .expect("run show");
    let show_stdout = String::from_utf8_lossy(&show.stdout);
    let show_stderr = String::from_utf8_lossy(&show.stderr);
    assert!(
        show.status.success(),
        "show exited {:?}\nstdout:\n{show_stdout}\nstderr:\n{show_stderr}",
        show.status.code()
    );
    assert!(show_stdout.contains("street River"), "missing node header: {show_stdout}");
    assert!(show_stdout.contains("legend:"), "missing rank-grid legend: {show_stdout}");
    assert!(show_stdout.contains('K'), "expected the KK row in the rank grid: {show_stdout}");

    let show_combo = bin()
        .args([
            "show",
            "--solution",
            out.to_str().unwrap(),
            "--line",
            "check,bet:100",
            "--combo",
            "KcKd",
        ])
        .output()
        .expect("run show --combo");
    let combo_stdout = String::from_utf8_lossy(&show_combo.stdout);
    assert!(show_combo.status.success(), "show --combo exited {:?}: {combo_stdout}", show_combo.status.code());
    assert!(combo_stdout.contains("combo KcKd"), "missing combo header: {combo_stdout}");
    assert!(combo_stdout.contains("call"), "expected a call line for a value hand: {combo_stdout}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn show_rejects_a_line_token_that_does_not_match_any_action() {
    let dir = std::env::temp_dir().join(format!("solver_cli_test_badline_{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let out = dir.join("solution.json");

    let solve = bin()
        .args([
            "solve",
            "--config",
            fixture().to_str().unwrap(),
            "--report-every",
            "200",
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .expect("run solve");
    assert!(solve.status.success());

    let show = bin()
        .args(["show", "--solution", out.to_str().unwrap(), "--line", "check,bet:33"])
        .output()
        .expect("run show");
    assert!(!show.status.success(), "expected a non-zero exit for an unmatched line token");
    let stderr = String::from_utf8_lossy(&show.stderr);
    assert!(stderr.contains("no action matches"), "unexpected stderr: {stderr}");

    std::fs::remove_dir_all(&dir).ok();
}

// Finding A: the lower-triangle (offsuit) lookup key was built (low_rank,
// high_rank) while `bucket_key` only ever emits (high_rank, low_rank), so every
// offsuit cell missed its bucket and printed "--" regardless of range content.
#[test]
fn offsuit_combo_renders_a_non_empty_grid_cell() {
    let dir = std::env::temp_dir().join(format!("solver_cli_test_offsuit_{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let out = dir.join("solution.json");

    let solve = bin()
        .args([
            "solve",
            "--config",
            offsuit_fixture().to_str().unwrap(),
            "--report-every",
            "200",
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .expect("run solve");
    assert!(solve.status.success(), "solve failed: {}", String::from_utf8_lossy(&solve.stderr));

    // No --line: the root node is OOP's decision, showing OOP's own range directly.
    let show = bin().args(["show", "--solution", out.to_str().unwrap()]).output().expect("run show");
    assert!(show.status.success(), "show failed: {}", String::from_utf8_lossy(&show.stderr));
    let stdout = String::from_utf8_lossy(&show.stdout);

    // A4o is live for OOP (unblocked by the board) and sits in the offsuit
    // (lower-triangle) half of the grid: row '4', column 'A'.
    let cell = grid_cell(&stdout, '4', 'A');
    assert_ne!(cell, "--", "offsuit cell A4o rendered empty:\n{stdout}");

    std::fs::remove_dir_all(&dir).ok();
}

// Finding B: a solution file whose stored combo_count disagrees with the
// rebuilt tree's live-combo count must fail loudly, not panic with an
// index-out-of-bounds while indexing the strategy array.
#[test]
fn show_reports_a_clear_error_instead_of_panicking_on_a_combo_count_mismatch() {
    let dir = std::env::temp_dir().join(format!("solver_cli_test_combocount_{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let out = dir.join("solution.json");
    let tampered = dir.join("tampered.json");

    let solve = bin()
        .args([
            "solve",
            "--config",
            fixture().to_str().unwrap(),
            "--report-every",
            "200",
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .expect("run solve");
    assert!(solve.status.success(), "solve failed: {}", String::from_utf8_lossy(&solve.stderr));

    let mut sol = Solution::load(&out).expect("load solution");
    let root = sol.nodes.iter_mut().find(|n| n.node == 0).expect("root node strategy");
    assert!(root.combo_count >= 2, "fixture must have at least 2 live combos to tamper with");
    let actions = root.actions.len();
    root.combo_count -= 1;
    root.strategy.truncate(actions * root.combo_count as usize);
    sol.save(&tampered).expect("save tampered solution");

    let show = bin().args(["show", "--solution", tampered.to_str().unwrap()]).output().expect("run show");
    let stderr = String::from_utf8_lossy(&show.stderr);
    assert!(!show.status.success(), "expected show to fail (not panic-crash) on a combo-count mismatch");
    assert!(!stderr.contains("panicked"), "show must not panic on a stale/tampered solution file: {stderr}");
    assert!(stderr.contains("node 0"), "error must name the offending node: {stderr}");

    std::fs::remove_dir_all(&dir).ok();
}

// Finding C: a 4-char action code (every bet/raise sized at >= 100% pot, e.g.
// "B100") ran directly into the frequency with no separator ("B100100%").
#[test]
fn grid_cell_keeps_the_action_code_and_frequency_separated_at_every_width() {
    let dir = std::env::temp_dir().join(format!("solver_cli_test_widecode_{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let out = dir.join("solution.json");
    let forced = dir.join("forced.json");

    let solve = bin()
        .args([
            "solve",
            "--config",
            fixture().to_str().unwrap(),
            "--report-every",
            "200",
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .expect("run solve");
    assert!(solve.status.success(), "solve failed: {}", String::from_utf8_lossy(&solve.stderr));

    // Force a pure (100%-frequency) bet strategy at the root so the dominant
    // action's code and its frequency are both known exactly, instead of relying
    // on CFR convergence to happen to land on 100%.
    let mut sol = Solution::load(&out).expect("load solution");
    let root = sol.nodes.iter_mut().find(|n| n.node == 0).expect("root node strategy");
    let bet_idx = root
        .actions
        .iter()
        .position(|a| matches!(a, ActionLabelData::Bet(_)))
        .expect("root has a bet action (100% pot, per the fixture sizing)");
    let combo_count = root.combo_count as usize;
    for a in 0..root.actions.len() {
        let freq = if a == bet_idx { 1.0 } else { 0.0 };
        for i in 0..combo_count {
            root.strategy[a * combo_count + i] = freq;
        }
    }
    sol.save(&forced).expect("save forced solution");

    let show = bin().args(["show", "--solution", forced.to_str().unwrap()]).output().expect("run show");
    assert!(show.status.success(), "show failed: {}", String::from_utf8_lossy(&show.stderr));
    let stdout = String::from_utf8_lossy(&show.stdout);

    // KK is a pure pair (row 'K', col 'K'), always bucketed correctly even before
    // Finding A's fix, so this test isolates Finding C.
    let cell = grid_cell(&stdout, 'K', 'K');
    assert_eq!(cell, "B100 100%", "code and frequency ran together with no separator:\n{stdout}");

    std::fs::remove_dir_all(&dir).ok();
}
