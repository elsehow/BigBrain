#!/usr/bin/env python3
"""macOS process-tree sampler: aggregate counters only, no argv or private names.
Parent closes stdin to finish. Short-lived children between samples are missed.
Reuses the native profiler's calibrated resource counter definitions.
"""
import ctypes as c
import json
import select
import statistics
import subprocess
import sys
import time
from profileNativeIdle import Usage, lib, NS_PER_TICK

pid, output = int(sys.argv[1]), sys.argv[2]
previous = {}
series = []
started = at = time.monotonic()
while not select.select([sys.stdin], [], [], 1)[0]:
    table = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True)
    parents = dict(tuple(map(int, line.split())) for line in table.splitlines())
    members = {pid}
    while True:
        expanded = members | {p for p, parent in parents.items() if parent in members}
        if expanded == members:
            break
        members = expanded
    # Exclude this sampler and the ps command it spawns.
    import os
    members -= {os.getpid()} | {p for p, parent in parents.items() if parent == os.getpid()}
    current = {}
    for p in members:
        usage = Usage()
        if lib.proc_pid_rusage(p, 2, c.byref(usage)) == 0:
            current[p] = (usage.proc_start_abstime, usage.user_time + usage.system_time, usage.phys_footprint / 1048576)
    now = time.monotonic()
    cpu = sum((r[1] - previous[p][1]) * NS_PER_TICK / 1e9 for p, r in current.items() if p in previous and r[0] == previous[p][0])
    series.append(dict(seconds=now-started, cpu_percent=cpu/(now-at)*100, footprint_mb=sum(r[2] for r in current.values()), processes=len(current), churn=set(current)!=set(previous)))
    previous, at = current, now
with open(output, 'w') as stream:
    json.dump(dict(samples=len(series), cpu_percent_mean=statistics.mean(r['cpu_percent'] for r in series) if series else None,
                   footprint_mb_peak=max((r['footprint_mb'] for r in series), default=None),
                   max_processes=max((r['processes'] for r in series),default=0),churn_samples=sum(r['churn'] for r in series),series=series),stream,indent=2)
