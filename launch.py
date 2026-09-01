#!/usr/bin/env python3
"""One-command study setup: build the engine, build the WASM pkg, start the
web workbench, and open it in your browser.

    python launch.py            # build what's missing/stale, launch, open browser
    python launch.py --rebuild  # force-rebuild the CLI and WASM pkg first

Ctrl+C stops the dev server.
"""

import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
PKG_WASM = os.path.join(ROOT, "wasm", "pkg", "solver_wasm_bg.wasm")


def need(tool, hint):
    path = shutil.which(tool)
    if not path:
        sys.exit(f"missing prerequisite: {tool}\n  install it with: {hint}")
    return path


def run(cmd, cwd=ROOT):
    print(f"\n$ {' '.join(cmd)}")
    if subprocess.call(cmd, cwd=cwd) != 0:
        sys.exit(f"command failed: {' '.join(cmd)}")


def newest_mtime(*dirs):
    latest = 0.0
    for d in dirs:
        for base, _, files in os.walk(d):
            for f in files:
                if f.endswith(".rs") or f == "Cargo.toml":
                    latest = max(latest, os.path.getmtime(os.path.join(base, f)))
    return latest


def wasm_stale():
    if not os.path.exists(PKG_WASM):
        return True
    src = newest_mtime(
        os.path.join(ROOT, "engine", "src"), os.path.join(ROOT, "wasm", "src")
    )
    return src > os.path.getmtime(PKG_WASM)


def free_port(start=3000, tries=10):
    for p in range(start, start + tries):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    sys.exit(f"no free port in {start}..{start + tries - 1}")


def wait_ready(url, cap_seconds=60):
    deadline = time.time() + cap_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="force-rebuild CLI and WASM")
    ap.add_argument(
        "--no-browser", action="store_true", help="don't open a browser tab"
    )
    args = ap.parse_args()

    cargo = need("cargo", "https://rustup.rs")
    wasm_pack = need("wasm-pack", "cargo install wasm-pack")
    npm = need("npm", "https://nodejs.org (Node 20+)")

    # 1. native CLI (cargo is incremental; cheap when already built)
    run([cargo, "build", "--release", "-p", "solver-cli"])

    # 2. WASM pkg for the browser
    if args.rebuild or wasm_stale():
        run([wasm_pack, "build", "wasm", "--target", "web", "--out-dir", "pkg"])
    else:
        print("wasm pkg up to date, skipping build")

    # 3. web dependencies
    if not os.path.isdir(os.path.join(WEB, "node_modules")):
        run([npm, "install"], cwd=WEB)

    # 4. dev server (npm run dev also syncs the wasm pkg + fixtures into web/)
    port = free_port()
    url = f"http://localhost:{port}"
    print(f"\nstarting workbench on {url} ...")
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    server = subprocess.Popen(
        [npm, "run", "dev", "--", "--port", str(port)], cwd=WEB, **kwargs
    )

    # 5. poll the real condition (HTTP 200), hard cap 60 s — never wait on log lines
    if not wait_ready(url):
        server.terminate()
        sys.exit(
            f"workbench did not answer on {url} within 60 s — check the npm output above"
        )

    solver_exe = os.path.join(ROOT, "target", "release", "solver")
    print(
        f"""
ready: {url}

study workflow
  in the browser: click "Turn spot" or "River spot" for a sample, or use the
  Solve tab for small spots (runs in-browser with a live exploitability curve).

  bigger spots — solve with the CLI (all cores), then load the JSON in the browser:
    {solver_exe} solve --config web-fixture.toml --out my_spot.json
    {solver_exe} show  --solution my_spot.json --line "check,bet:50"

Ctrl+C stops the server.
"""
    )
    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.wait()
    except KeyboardInterrupt:
        print("\nstopping...")
        if os.name == "nt":
            subprocess.call(
                ["taskkill", "/PID", str(server.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            server.terminate()
    sys.exit(0)


if __name__ == "__main__":
    main()
