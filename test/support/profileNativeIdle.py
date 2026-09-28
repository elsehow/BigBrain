#!/usr/bin/env python3
"""macOS app-wide sampler. Explicit PID; no arguments, paths or content in output.
Uses Apple's resource coalition to include launchd-parented WebKit helpers.
CPU: deltas of proc_pid_rusage Mach ticks, one core = 100%. Memory: physical
footprint (includes compressed memory) plus RSS; summed RSS can double count.
Coalition flavor 20 is a private diagnostic API; fail closed if unsupported.
"""
import argparse
import ctypes as c
import json
import os
import statistics
import time

lib = c.CDLL('/usr/lib/libproc.dylib', use_errno=True)
lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
lib.proc_pid_rusage.argtypes = [c.c_int, c.c_int, c.c_void_p]
lib.proc_listallpids.argtypes = [c.c_void_p, c.c_int]
lib.proc_pidpath.argtypes = [c.c_int, c.c_void_p, c.c_uint32]
# Public rusage_info_v2 layout in sys/resource.h. CPU counters are Mach ticks.
class Timebase(c.Structure):
    _fields_ = [('numer', c.c_uint32), ('denom', c.c_uint32)]
timebase = Timebase()
c.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(c.byref(timebase))
NS_PER_TICK = timebase.numer / timebase.denom
FIELDS = 'user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size resident_size phys_footprint proc_start_abstime proc_exit_abstime child_user_time child_system_time child_pkg_idle_wkups child_interrupt_wkups child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten'.split()
class Usage(c.Structure):
    _fields_ = [('uuid', c.c_uint8 * 16)] + [(name, c.c_uint64) for name in FIELDS]

def coalition(pid):
    value = (c.c_uint64 * 5)()
    if lib.proc_pidinfo(pid, 20, 0, c.byref(value), c.sizeof(value)) != c.sizeof(value):
        return None
    return value[0] or None

def snapshot(owner):
    count = lib.proc_listallpids(None, 0)
    pids = (c.c_int * (count + 128))()
    count = lib.proc_listallpids(pids, c.sizeof(pids))
    rows = {}
    for pid in pids[:count]:
        if not pid or coalition(pid) != owner:
            continue
        usage = Usage()
        if lib.proc_pid_rusage(pid, 2, c.byref(usage)) != 0:
            continue
        path = c.create_string_buffer(4096)
        lib.proc_pidpath(pid, path, len(path))
        name = os.path.basename(path.value.decode(errors='replace'))
        # Never export arbitrary executable names from spawned user commands.
        role = {'bigbrain-desktop': 'shell', 'bun': 'engine',
                'com.apple.WebKit.GPU': 'webkit_gpu_helper',
                'com.apple.WebKit.WebContent': 'webkit_renderer',
                'com.apple.WebKit.Networking': 'webkit_network'}.get(name, 'other_child')
        rows[pid] = dict(role=role, start=usage.proc_start_abstime,
                         cpu_ticks=usage.user_time + usage.system_time,
                         footprint_mb=usage.phys_footprint / 1048576,
                         rss_mb=usage.resident_size / 1048576,
                         wakeups=usage.pkg_idle_wkups)
    return rows

def measure(pid, seconds=30, interval=2):
    owner = coalition(pid)
    if not owner:
        raise RuntimeError('Cannot identify target resource coalition')
    previous = snapshot(owner)
    if pid not in previous:
        raise RuntimeError('Target process accounting unavailable')
    at = started = time.monotonic()
    series = []
    while time.monotonic() - started < seconds:
        time.sleep(interval)
        current = snapshot(owner)
        end = time.monotonic()
        elapsed = end - at
        grouped = {}
        churn = set(current) != set(previous)
        for key, row in current.items():
            group = grouped.setdefault(row['role'], dict(cpu_percent=0, footprint_mb=0, rss_mb=0, wakeups_per_sec=0, processes=0))
            group['processes'] += 1
            for field in ['footprint_mb', 'rss_mb']:
                group[field] += row[field]
            old = previous.get(key)
            if old and old['start'] == row['start']:
                group['cpu_percent'] += (row['cpu_ticks'] - old['cpu_ticks']) * NS_PER_TICK / (elapsed * 1e9) * 100
                group['wakeups_per_sec'] += (row['wakeups'] - old['wakeups']) / elapsed
        series.append(dict(seconds=round(end - started, 3), process_churn=churn, groups=grouped))
        previous, at = current, end
    roles = sorted({role for row in series for role in row['groups']})
    summary = {}
    for role in roles:
        rows = [row['groups'].get(role, dict(cpu_percent=0, footprint_mb=0, rss_mb=0, wakeups_per_sec=0)) for row in series]
        summary[role] = {f'{field}_mean': round(statistics.mean(row[field] for row in rows), 3)
                         for field in ['cpu_percent', 'footprint_mb', 'rss_mb', 'wakeups_per_sec']}
    return dict(duration_seconds=round(at-started, 3), sample_count=len(series),
                process_churn=any(row['process_churn'] for row in series), groups=summary,
                cpu_percent_total_mean=round(sum(row['cpu_percent_mean'] for row in summary.values()), 3),
                footprint_mb_total_mean=round(sum(row['footprint_mb_mean'] for row in summary.values()), 3), samples=series)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int)
    parser.add_argument('--calibrate', action='store_true', help='Check native CPU time conversion against this process CPU clock')
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.calibrate:
        a, z = Usage(), Usage()
        lib.proc_pid_rusage(os.getpid(), 2, c.byref(a))
        started = time.process_time()
        while time.process_time() - started < 0.15:
            sum(range(1000))
        elapsed = time.process_time() - started
        lib.proc_pid_rusage(os.getpid(), 2, c.byref(z))
        measured = (z.user_time + z.system_time - a.user_time - a.system_time) * NS_PER_TICK / 1e9
        ratio = measured / elapsed
        print(json.dumps(dict(cpu_clock_seconds=elapsed, native_cpu_seconds=measured, ratio=ratio, ns_per_tick=NS_PER_TICK)))
        if not 0.95 < ratio < 1.05:
            raise SystemExit('CPU counter calibration failed')
        raise SystemExit(0)
    if not args.pid:
        parser.error('--pid is required unless --calibrate is used')
    if args.seconds < 2:
        parser.error('--seconds must be at least 2')
    result = measure(args.pid, args.seconds)
    data = json.dumps(result, indent=2) + '\n'
    if args.output:
        with open(args.output, 'w') as stream:
            stream.write(data)
    else:
        print(data)
