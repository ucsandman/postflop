//! Real-binary integration test: runs the actual `solver` executable end to end
//! (`solve` then `show`) via `std::process::Command`, not in-process function
//! calls, and asserts on exit codes and real stdout.

use std::path::PathBuf;
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_solver"))
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/river.toml")
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
