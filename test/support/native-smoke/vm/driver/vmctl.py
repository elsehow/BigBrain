#!/usr/bin/env python3
"""Client for a running bbvm control socket. Every command is appended to the
run log named by BBVM_LOG (JSON lines) so a manual run can be replayed later.

  vmctl.py SOCKET state
  vmctl.py SOCKET shot PATH
  vmctl.py SOCKET click X Y [--right] [--count N]
  vmctl.py SOCKET move X Y | drag X1 Y1 X2 Y2 | scroll X Y [--dy N] [--dx N]
  vmctl.py SOCKET key COMBO            (e.g. cmd+space, return, shift+tab)
  vmctl.py SOCKET type TEXT [--delay-ms N]
  vmctl.py SOCKET stop | kill
  vmctl.py SOCKET wait-stopped STATUS_JSON [--timeout S]
"""
import argparse
import json
import os
import socket
import sys
import time


def send(sock_path, request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(120)
        s.connect(sock_path)
        s.sendall((json.dumps(request) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    reply = json.loads(buf.decode() or "{}")
    log = os.environ.get("BBVM_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"t": time.time(), "request": request, "reply": reply}) + "\n")
    return reply


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("socket")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("state")
    q = sub.add_parser("shot"); q.add_argument("path")
    q = sub.add_parser("click"); q.add_argument("x", type=float); q.add_argument("y", type=float); q.add_argument("--right", action="store_true"); q.add_argument("--count", type=int, default=1)
    q = sub.add_parser("move"); q.add_argument("x", type=float); q.add_argument("y", type=float)
    q = sub.add_parser("drag"); [q.add_argument(n, type=float) for n in ("x1", "y1", "x2", "y2")]
    q = sub.add_parser("scroll"); q.add_argument("x", type=float); q.add_argument("y", type=float); q.add_argument("--dy", type=float, default=-3); q.add_argument("--dx", type=float, default=0)
    q = sub.add_parser("key"); q.add_argument("combo")
    q = sub.add_parser("type"); q.add_argument("text"); q.add_argument("--delay-ms", type=int, default=12)
    sub.add_parser("stop"); sub.add_parser("kill")
    q = sub.add_parser("wait-stopped"); q.add_argument("status"); q.add_argument("--timeout", type=float, default=300)
    a = p.parse_args()
    if a.cmd == "wait-stopped":
        deadline = time.time() + a.timeout
        while time.time() < deadline:
            try:
                st = json.load(open(a.status))
            except (OSError, ValueError):
                st = {}
            alive = st.get("pid") and os.path.exists(f"/proc/{st['pid']}")  # never true on macOS; fall through to kill(0)
            try:
                os.kill(int(st.get("pid", 0)), 0); alive = True
            except (ProcessLookupError, ValueError, PermissionError):
                alive = False
            if st.get("state") in ("exited", "stopped") and not alive:
                print(json.dumps({"stopped": True, "status": st})); return 0
            time.sleep(2)
        print(json.dumps({"stopped": False, "error": "timeout"})); return 1
    req = {"cmd": {"shot": "screenshot"}.get(a.cmd, a.cmd)}
    for k in ("path", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy", "combo", "text", "count"):
        if hasattr(a, k):
            req[k] = getattr(a, k)
    if getattr(a, "right", False):
        req["button"] = "right"
    if hasattr(a, "delay_ms"):
        req["delayMs"] = a.delay_ms
    if req["cmd"] == "screenshot":
        req["path"] = os.path.abspath(req["path"])
    reply = send(a.socket, req)
    print(json.dumps(reply))
    return 0 if "error" not in reply else 1


if __name__ == "__main__":
    sys.exit(main())
