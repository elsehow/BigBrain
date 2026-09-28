#!/usr/bin/env python3
"""Fail-closed native isolation experiment, NOT a BigBrain launcher.

Only fabricated files and local HTTP canaries are used. The negative controls
are expected to fail: sandbox-exec does not contain WebKit's network process.
Requires macOS, Xcode CLT and a GUI session. See README.md.
"""
import argparse
import hashlib
import http.server
import json
from pathlib import Path
import platform
import select
import socket
import subprocess
import tempfile
import threading


def verdict(stdout, requests, allowed, denied, returncode):
    """Missing probes are failures too; a blocked startup is not containment."""
    checks = {
        "native_exit": returncode == 0,
        "forbidden_file_read": "FILE_READ BLOCKED\n" in stdout,
        "forbidden_file_write": "FILE_WRITE BLOCKED\n" in stdout,
        "disposable_write": "FILE_ALLOWED_WRITE ALLOWED" in stdout,
        "allowed_network": [allowed, "/allowed"] in requests,
        "denied_network": [denied, "/forbidden"] not in requests,
        "webview_completed": "WEBKIT " in stdout and '"BLOCKED"] error=(null)' in stdout,
    }
    return {"passed": all(checks.values()), "checks": checks}


def run(mode):
    root = Path(tempfile.mkdtemp(prefix="bb-native-boundary-", dir="/private/tmp"))
    home = root / "home"
    (home / "rules").mkdir(parents=True)
    (root / "forbidden").mkdir()
    (root / "forbidden/canary").write_text("synthetic secret")
    (root / "tmp").mkdir()
    seen = []

    class Server(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append([self.server.server_port, self.path])
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"<!doctype html><title>Disposable boundary canary</title>")

        def log_message(self, *args):
            pass

    servers = [http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server) for _ in range(2)]
    allowed, denied = [s.server_port for s in servers]

    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_CONNECT(self):
            seen.append(["proxy", self.path])
            if self.path != f"127.0.0.1:{allowed}":
                self.send_error(403)
                return
            with socket.create_connection(("127.0.0.1", allowed), timeout=5) as peer:
                self.send_response(200)
                self.end_headers()
                while True:
                    ready, _, _ = select.select([self.connection, peer], [], [], 5)
                    if not ready:
                        return
                    for incoming in ready:
                        data = incoming.recv(65536)
                        if not data:
                            return
                        (peer if incoming is self.connection else self.connection).sendall(data)

        def log_message(self, *args):
            pass

    proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    servers.append(proxy)
    # The forbidden fixture exercises the SAME read rule as user directories.
    # This policy is experimental, not certified containment of XPC services.
    policy = f'''(version 1)
(allow default)
(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/Library/Keychains") (subpath "{root}/forbidden"))
(deny file-write*)
(allow file-write* (subpath "{home}") (subpath "{root}/tmp") (literal "/dev/null"))
(deny network*)
(allow network-outbound (remote ip "localhost:{allowed}"))
(deny mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))
(deny appleevent-send)
(deny process-exec (subpath "/Applications") (subpath "/opt/homebrew") (subpath "/usr/local") (subpath "/Users"))
'''
    (root / "sandbox.sb").write_text(policy)
    source = Path(__file__).with_name("probe.m")
    subprocess.run([
        "xcrun", "clang", "-fobjc-arc", "-framework", "Cocoa", "-framework", "WebKit",
        "-framework", "Network", str(source), "-o", str(root / "probe"),
    ], check=True)
    # Never inherit connector credentials, real provider homes, ports or overrides.
    env = {
        "HOME": str(home), "CFFIXED_USER_HOME": str(home), "TMPDIR": str(root / "tmp"),
        "PATH": "/usr/bin:/bin", "PROBE_ROOT": str(root),
        "ALLOWED_PORT": str(allowed), "DENIED_PORT": str(denied),
    }
    if mode == "proxy":
        env["PROXY_PORT"] = str(proxy.server_port)
    if mode == "content-block":
        env["CONTENT_BLOCK"] = "1"
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        p = subprocess.run([
            "/usr/bin/sandbox-exec", "-f", str(root / "sandbox.sb"), str(root / "probe"),
        ], env=env, cwd=root, capture_output=True, text=True, timeout=30)
        result = {
            "root": str(root), "mode": mode, "macOS": platform.mac_ver()[0],
            "probeSourceSHA256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "policySHA256": hashlib.sha256(policy.encode()).hexdigest(),
            "exit": p.returncode, "stdout": p.stdout, "stderr": p.stderr,
            "requests": seen, "allowedPort": allowed, "deniedPort": denied,
            **verdict(p.stdout, seen, allowed, denied, p.returncode),
        }
    except subprocess.TimeoutExpired as error:
        # subprocess.run kills and waits for its own probe, never an existing app.
        result = {"root": str(root), "mode": mode, "passed": False, "error": str(error)}
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["sandbox", "proxy", "content-block"], default="sandbox")
    raise SystemExit(run(parser.parse_args().mode))
