//! Jobs: each `exec` is a command in its own session, whose process group is
//! the job. One reaper collects every child (the guest may be PID 1, and then
//! every orphan is its child too); nothing else calls wait.

use crate::frame::{self, Frame, FrameError};
use crate::proto::{bad, err, Error, Req};
use crate::{now_ms, Guest};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const LIVE_MAX: usize = 64;
pub const RING: usize = 256 * 1024;
const DEFAULT_GRACE: u64 = 3000;

pub type Exit = (Option<i32>, Option<String>);

/// Held while the guest runs a helper of its own and waits for it (lsof, on
/// macOS): the reaper takes it before reaping, so it never collects a child
/// whose own caller is about to wait for it.
pub static REAP: Mutex<()> = Mutex::new(());

pub struct Job {
    pub argv: Vec<String>,
    pub started: u64,
    pub pid: i32,
    pub exited: Option<Exit>,
    pub detached: bool,
    ring: VecDeque<u8>,
    total: u64,
}

#[derive(Default)]
pub struct Jobs {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    jobs: HashMap<u64, Job>,
    next: u64,
    /// Children spawned and not yet reaped: the reaper sleeps while there are none.
    children: usize,
}

impl Jobs {
    /// The reaper: every child's exit, recorded against its job when it led one.
    pub fn reap(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || loop {
            // peek without reaping, then reap under the lock: a spawn in
            // progress holds it, and std reaps a child whose exec failed itself
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe { libc::waitid(libc::P_ALL, 0, &mut info, libc::WEXITED | libc::WNOWAIT) } < 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                // no children: wait for one
                let st = me.state.lock().unwrap();
                let _ = me.changed.wait_timeout_while(st, Duration::from_secs(1), |s| s.children == 0);
                continue;
            }
            let pid = unsafe { info.si_pid() };
            let _reaping = REAP.lock().unwrap_or_else(|e| e.into_inner());
            let mut st = me.state.lock().unwrap();
            let mut status = 0;
            if unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } != pid {
                continue;
            }
            let exit = if libc::WIFEXITED(status) {
                (Some(libc::WEXITSTATUS(status)), None)
            } else if libc::WIFSIGNALED(status) {
                (None, Some(signal_name(libc::WTERMSIG(status))))
            } else {
                continue;
            };
            if let Some(job) = st.jobs.values_mut().find(|j| j.pid == pid && j.exited.is_none()) {
                job.exited = Some(exit);
                st.children = st.children.saturating_sub(1);
            }
            me.changed.notify_all();
        });
    }

    fn live(&self) -> usize {
        self.state.lock().unwrap().jobs.values().filter(|j| j.exited.is_none()).count()
    }

    fn push(&self, id: u64, bytes: &[u8]) {
        let mut st = self.state.lock().unwrap();
        if let Some(j) = st.jobs.get_mut(&id) {
            j.total += bytes.len() as u64;
            j.ring.extend(bytes);
            let over = j.ring.len().saturating_sub(RING);
            j.ring.drain(..over);
        }
    }

    fn wait_exit(&self, id: u64) -> Option<Exit> {
        let st = self.state.lock().unwrap();
        let st = self.changed.wait_while(st, |s| s.jobs.get(&id).is_some_and(|j| j.exited.is_none())).unwrap();
        st.jobs.get(&id).and_then(|j| j.exited.clone())
    }

    pub fn pid_of(&self, id: u64) -> Option<i32> {
        self.state.lock().unwrap().jobs.get(&id).map(|j| j.pid)
    }

    /// The job whose process group `pgid` is.
    pub fn by_group(&self, pgid: i32) -> Option<u64> {
        self.state.lock().unwrap().jobs.iter().find(|(_, j)| j.pid == pgid).map(|(id, _)| *id)
    }

    /// Every job's leader, for `shutdown`.
    pub fn groups(&self) -> Vec<i32> {
        self.state.lock().unwrap().jobs.values().map(|j| j.pid).collect()
    }
}

pub fn signal_name(n: i32) -> String {
    let name = match n {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGUSR2 => "SIGUSR2",
        _ => return format!("SIG{n}"),
    };
    name.to_string()
}

fn group_alive(pgid: i32) -> bool {
    unsafe { libc::kill(-pgid, 0) == 0 }
}

/// TERM a process group, then KILL it after `grace`; returns once it is gone.
pub fn stop_group(pgid: i32, grace: u64) {
    if pgid <= 1 {
        return;
    }
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_millis(grace);
    while group_alive(pgid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if group_alive(pgid) {
        unsafe { libc::kill(-pgid, libc::SIGKILL) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while group_alive(pgid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// `exec`: answers, streams the job's output, then its exit; the connection ends with it.
pub fn exec(g: &Arc<Guest>, req: &Req, conn: UnixStream) -> Result<(), Error> {
    let argv = req.list("argv");
    if argv.is_empty() || argv.len() > crate::proto::ARGV_MAX {
        return Err(bad(format!("argv has 1 to {} entries", crate::proto::ARGV_MAX)));
    }
    if argv.iter().map(|a| a.len() + 1).sum::<usize>() > crate::proto::ARGV_BYTES || argv.iter().any(|a| a.contains('\0')) {
        return Err(bad("argv is over 1 MiB, or holds a NUL"));
    }
    let env = req.map("env");
    if env.len() > crate::proto::ENV_MAX
        || env.iter().map(|(k, v)| k.len() + v.len() + 2).sum::<usize>() > crate::proto::ENV_BYTES
        || env.iter().any(|(k, v)| k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0'))
    {
        return Err(bad("env has at most 1,024 entries and 128 KiB, each NAME=value without NUL"));
    }
    let cwd = req.path("cwd")?;
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(err("not-found", "cwd is not a folder"));
    }
    let root = match req.str("user") {
        "work" => false,
        "root" if g.machine => true,
        "root" => return Err(bad("this guest runs everything as itself")),
        _ => return Err(bad("user is work or root")),
    };
    if g.jobs.live() >= LIVE_MAX {
        return Err(err("limit", format!("{LIVE_MAX} jobs are already running")));
    }
    let grace = req.opt_int("grace").unwrap_or(DEFAULT_GRACE);
    let with_stdin = req.bool("stdin");

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&cwd).env_clear();
    if g.machine {
        for (k, v) in g.base_env(root) {
            cmd.env(k, v);
        }
    }
    cmd.envs(env);
    cmd.stdin(if with_stdin { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let owner = if g.machine && !root { g.owner } else { None };
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if let Some((uid, gid)) = owner {
                let groups = [gid];
                if libc::setgroups(1, groups.as_ptr()) < 0 || libc::setgid(gid) < 0 || libc::setuid(uid) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }

    // spawn and register under one lock, so the reaper can't miss a fast exit
    let (id, pid, mut child) = {
        let mut st = g.jobs.state.lock().unwrap();
        let child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => err("not-found", format!("no such program: {}", crate::proto::clip(&argv[0]))),
            _ => Error::from(e),
        })?;
        st.next += 1;
        let id = st.next;
        let pid = child.id() as i32;
        st.jobs.insert(id, Job { argv: argv.clone(), started: now_ms(), pid, exited: None, detached: false, ring: VecDeque::new(), total: 0 });
        st.children += 1;
        g.jobs.changed.notify_all();
        (id, pid, child)
    };

    let sink = Arc::new(Mutex::new(Some(conn.try_clone()?)));
    {
        let mut w = sink.lock().unwrap();
        if let Some(s) = w.as_mut() {
            if frame::write_control(s, &json!({ "ok": true, "job": id, "pid": pid })).is_err() {
                *w = None;
            }
        }
    }

    // each pipe: into the ring, and onto the connection while it lasts
    let pump = |mut pipe: Box<dyn Read + Send>, kind: u8| {
        let jobs = g.jobs.clone();
        let sink = sink.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                jobs.push(id, &buf[..n]);
                let mut w = sink.lock().unwrap();
                if let Some(s) = w.as_mut() {
                    if frame::write_bytes(s, kind, &buf[..n]).is_err() {
                        *w = None;
                    }
                }
            }
        })
    };
    let out = pump(Box::new(child.stdout.take().unwrap()), frame::STDOUT);
    let errs = pump(Box::new(child.stderr.take().unwrap()), frame::STDERR);
    let mut stdin = child.stdin.take();
    // the reaper owns the child's exit status; this handle only held its pipes
    drop(child);

    let finished = Arc::new(Mutex::new(false));
    {
        let jobs = g.jobs.clone();
        let sink = sink.clone();
        let finished = finished.clone();
        let conn = conn.try_clone()?;
        std::thread::spawn(move || {
            let exit = jobs.wait_exit(id);
            let _ = out.join();
            let _ = errs.join();
            let (code, signal) = exit.unwrap_or((None, None));
            *finished.lock().unwrap() = true;
            if let Some(s) = sink.lock().unwrap().as_mut() {
                let _ = frame::write_control(s, &json!({ "event": "exit", "code": code, "signal": signal }));
            }
            let _ = conn.shutdown(std::net::Shutdown::Both);
        });
    }

    // this thread reads the host's side: stdin, and the connection closing
    let mut conn = conn;
    loop {
        match frame::read(&mut conn) {
            Ok(Frame::Bytes(frame::STDIN, bytes)) => {
                if bytes.is_empty() {
                    stdin = None;
                } else if let Some(i) = stdin.as_mut() {
                    if i.write_all(&bytes).is_err() {
                        stdin = None;
                    }
                }
            }
            Ok(_) => break,
            Err(FrameError::Closed) | Err(_) => break,
        }
    }
    drop(stdin);
    if *finished.lock().unwrap() {
        return Ok(());
    }
    // the host went away mid-job
    *sink.lock().unwrap() = None;
    let detached = g.jobs.state.lock().unwrap().jobs.get(&id).is_some_and(|j| j.detached);
    if !detached {
        stop_group(pid, grace);
    }
    Ok(())
}

pub fn detach(g: &Guest, req: &Req) -> Result<Value, Error> {
    let mut st = g.jobs.state.lock().unwrap();
    let job = st.jobs.get_mut(&req.int("job")).ok_or_else(|| err("no-such-job", "no such job"))?;
    job.detached = true;
    Ok(json!({ "ok": true }))
}

pub fn stop(g: &Guest, req: &Req) -> Result<Value, Error> {
    let pid = g.jobs.pid_of(req.int("job")).ok_or_else(|| err("no-such-job", "no such job"))?;
    stop_group(pid, req.int("grace"));
    Ok(json!({ "ok": true }))
}

pub fn list(g: &Guest) -> Result<Value, Error> {
    let listeners = crate::ports::listeners();
    let st = g.jobs.state.lock().unwrap();
    let mut ids: Vec<&u64> = st.jobs.keys().collect();
    ids.sort();
    let jobs: Vec<Value> = ids
        .into_iter()
        .map(|id| {
            let j = &st.jobs[id];
            let mut ports: Vec<u16> = listeners.iter().filter(|l| l.pgid == j.pid).map(|l| l.port).collect();
            ports.sort();
            ports.dedup();
            json!({
                "job": id, "argv": j.argv, "started": j.started,
                "exited": j.exited.as_ref().map(|(c, s)| json!({ "code": c, "signal": s })),
                "ports": ports,
            })
        })
        .collect();
    Ok(json!({ "ok": true, "jobs": jobs }))
}

pub fn output<W: Write>(g: &Guest, req: &Req, w: &mut W) -> Result<(), Error> {
    let (from, to, bytes) = {
        let st = g.jobs.state.lock().unwrap();
        let j = st.jobs.get(&req.int("job")).ok_or_else(|| err("no-such-job", "no such job"))?;
        let first = j.total - j.ring.len() as u64;
        let from = req.int("since").clamp(first, j.total);
        let skip = (from - first) as usize;
        let bytes: Vec<u8> = j.ring.iter().skip(skip).copied().collect();
        (from, j.total, bytes)
    };
    frame::write_control(w, &json!({ "ok": true, "from": from, "to": to }))?;
    frame::write_data(w, frame::DATA, &bytes)?;
    Ok(())
}
