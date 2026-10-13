//! bigbrain-guest: the agent inside a desktop's machine.
//!
//! `--init` (or no arguments, as PID 1): PID 1 of the machine. Mounts the basics, loads the kernel
//! modules the initramfs carries, moves onto the machine's disk, and serves
//! the guest protocol on vsock 7470, with the egress forwarder on
//! 127.0.0.1:3128.
//!
//! `--serve --unix <path>`: the same protocol on a Unix socket, run as
//! whoever starts it: tests, and the sandboxed mode.
//!
//! The protocol is packages/agents/PROTOCOL.md.

#[cfg(target_os = "linux")]
mod egress;
mod files;
mod frame;
#[cfg(target_os = "linux")]
mod init;
mod jobs;
mod ports;
mod proto;
#[cfg(target_os = "linux")]
mod vsock;

use frame::{Frame, FrameError};
use proto::{bad, err, Error, Req};
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GUEST_PORT: u32 = 7470;
const CONNECTIONS_MAX: usize = 64;

pub struct Guest {
    /// PID 1 of a machine: steps the clock, runs commands as `work`, powers off.
    pub machine: bool,
    /// Who owns what the guest creates, and runs `work`'s commands: (uid, gid).
    pub owner: Option<(u32, u32)>,
    pub image: String,
    pub booted: u64,
    pub tz: Mutex<String>,
    pub jobs: Arc<jobs::Jobs>,
    connections: AtomicUsize,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn unique() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

impl Guest {
    /// A machine's commands' environment, under what the host sends (PROTOCOL.md, exec).
    pub fn base_env(&self, root: bool) -> Vec<(String, String)> {
        let proxy = "http://127.0.0.1:3128";
        let (home, user) = if root { ("/root", "root") } else { ("/home/work", "work") };
        let mut env: Vec<(String, String)> = [
            ("PATH", format!("{home}/.local/bin:{home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")),
            ("HOME", home.into()),
            ("USER", user.into()),
            ("LOGNAME", user.into()),
            ("LANG", "C.UTF-8".into()),
            ("TERM", "dumb".into()),
            ("TMPDIR", "/tmp".into()),
            ("NO_PROXY", "localhost,127.0.0.1,::1".into()),
            ("no_proxy", "localhost,127.0.0.1,::1".into()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "npm_config_proxy", "npm_config_https_proxy"] {
            env.push((k.into(), proxy.into()));
        }
        let tz = self.tz.lock().unwrap().clone();
        if !tz.is_empty() {
            env.push(("TZ".into(), tz));
        }
        env
    }

    /// Step the clock to the host's when they differ by more than a second.
    fn clock(&self, now: Option<u64>) {
        let Some(now) = now else { return };
        if !self.machine || now.abs_diff(now_ms()) <= 1000 {
            return;
        }
        let tv = libc::timeval { tv_sec: (now / 1000) as _, tv_usec: ((now % 1000) * 1000) as _ };
        unsafe { libc::settimeofday(&tv, std::ptr::null()) };
    }
}

/// When the guest started, by its clock now: a machine boots before the host sets its clock.
fn booted(fallback: u64) -> u64 {
    let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
    #[cfg(target_os = "linux")]
    let clock = libc::CLOCK_BOOTTIME;
    #[cfg(not(target_os = "linux"))]
    let clock = libc::CLOCK_MONOTONIC;
    if cfg!(target_os = "linux") && unsafe { libc::clock_gettime(clock, &mut ts) } == 0 {
        return now_ms().saturating_sub(ts.tv_sec as u64 * 1000 + ts.tv_nsec as u64 / 1_000_000);
    }
    fallback
}

fn answer(conn: &mut UnixStream, r: Result<Value, Error>) {
    let v = r.unwrap_or_else(|e| json!({ "ok": false, "error": e.code, "message": e.message }));
    let _ = frame::write_control(conn, &v);
}

/// One connection: one request, its answer, and whatever the op streams.
fn serve_one(g: Arc<Guest>, mut conn: UnixStream) {
    let req = match frame::read(&mut conn) {
        Ok(Frame::Control(v)) => Req::parse(v),
        Ok(_) => Err(bad("a connection opens with a control frame")),
        Err(FrameError::Closed) => return,
        Err(FrameError::Bad(m)) => Err(bad(m)),
        Err(FrameError::Io(_)) => return,
    };
    let req = match req {
        Ok(r) => r,
        Err(e) => return answer(&mut conn, Err(e)),
    };
    g.clock(req.now);
    let result: Result<Option<Value>, Error> = match req.op.as_str() {
        "hello" => {
            *g.tz.lock().unwrap() = req.str("tz").chars().filter(|c| c.is_ascii_graphic()).take(64).collect();
            Ok(Some(json!({
                "ok": true, "protocol": proto::PROTOCOL, "agent": VERSION, "image": g.image,
                "arch": std::env::consts::ARCH, "booted": booted(g.booted),
            })))
        }
        "exec" => match conn.try_clone() {
            Ok(c) => jobs::exec(&g, &req, c).map(|_| None),
            Err(e) => Err(e.into()),
        },
        "detach" => jobs::detach(&g, &req).map(Some),
        "job.stop" => jobs::stop(&g, &req).map(Some),
        "job.list" => jobs::list(&g).map(Some),
        "job.output" => jobs::output(&g, &req, &mut conn).map(|_| None),
        "ports" => Ok(Some(json!({
            "ok": true,
            "ports": ports::listeners().iter().map(|l| json!({ "port": l.port, "pid": l.pid, "job": g.jobs.by_group(l.pgid) })).collect::<Vec<_>>(),
        }))),
        "connect" => connect(&req, conn.try_clone()).map(|_| None),
        "stat" => files::stat(&req).map(Some),
        "list" => files::list(&req).map(Some),
        "read" => files::read(&req, &mut conn).map(|_| None),
        "write" => files::write(&g, &req, &mut conn).map(Some),
        "shutdown" => {
            answer(&mut conn, Ok(json!({ "ok": true })));
            let _ = conn.flush();
            drop(conn);
            shutdown(&g);
            return;
        }
        _ => Err(bad("unknown op")),
    };
    match result {
        Ok(Some(v)) => answer(&mut conn, Ok(v)),
        Ok(None) => {}
        Err(e) => answer(&mut conn, Err(e)),
    }
}

fn connect(req: &Req, conn: std::io::Result<UnixStream>) -> Result<(), Error> {
    let mut conn = conn?;
    let port = req.int("port");
    if port == 0 || port > 65535 {
        return Err(bad("port is 1 to 65535"));
    }
    let tcp = std::net::TcpStream::connect(("127.0.0.1", port as u16)).map_err(|e| err("not-found", format!("nothing answers on port {port}: {e}")))?;
    frame::write_control(&mut conn, &json!({ "ok": true }))?;
    splice(tcp, conn);
    Ok(())
}

#[cfg(target_os = "linux")]
fn splice(tcp: std::net::TcpStream, conn: UnixStream) {
    egress::splice(tcp, conn)
}

#[cfg(not(target_os = "linux"))]
fn splice(tcp: std::net::TcpStream, conn: UnixStream) {
    use std::io::Read;
    let (mut t2, mut c2) = match (tcp.try_clone(), conn.try_clone()) {
        (Ok(t), Ok(c)) => (t, c),
        _ => return,
    };
    let back = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c2, &mut t2);
        let _ = t2.shutdown(std::net::Shutdown::Write);
    });
    let (mut t, mut c) = (tcp, conn);
    let mut buf = vec![0u8; 64 * 1024];
    while let Ok(n) = t.read(&mut buf) {
        if n == 0 || c.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    let _ = c.shutdown(std::net::Shutdown::Write);
    let _ = back.join();
}

/// Stop every job, then power off (a machine) or exit.
fn shutdown(g: &Guest) {
    let groups = g.jobs.groups();
    let stoppers: Vec<_> = groups.into_iter().map(|pg| std::thread::spawn(move || jobs::stop_group(pg, 3000))).collect();
    for s in stoppers {
        let _ = s.join();
    }
    #[cfg(target_os = "linux")]
    if g.machine {
        init::power_off();
    }
    std::process::exit(0);
}

/// Accept connections forever, each on its own thread, at most 64 at once.
fn serve(g: Arc<Guest>, mut accept: impl FnMut() -> std::io::Result<UnixStream>) -> ! {
    loop {
        let mut conn = match accept() {
            Ok(c) => c,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        };
        if g.connections.fetch_add(1, Ordering::SeqCst) >= CONNECTIONS_MAX {
            g.connections.fetch_sub(1, Ordering::SeqCst);
            // take the request first, briefly: a client that sees the answer
            // and the close before it has sent anything may not see the answer
            std::thread::spawn(move || {
                let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                let _ = frame::read(&mut conn);
                answer(&mut conn, Err(err("limit", format!("{CONNECTIONS_MAX} connections are already open"))));
            });
            continue;
        }
        let g = g.clone();
        std::thread::spawn(move || {
            let g2 = g.clone();
            // a panic ends this connection, never the guest
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| serve_one(g2, conn)));
            g.connections.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn usage() -> ! {
    eprintln!("usage: bigbrain-guest --serve --unix <path> | --init");
    std::process::exit(2);
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // the kernel starts an initramfs's /init with no arguments
    if args.is_empty() && std::process::id() == 1 {
        args.push("--init".into());
    }
    let jobs = Arc::new(jobs::Jobs::default());
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--serve", "--unix", path] => {
            let _ = std::fs::remove_file(path);
            let listener = UnixListener::bind(path).unwrap_or_else(|e| {
                eprintln!("bigbrain-guest: can't listen on {path}: {e}");
                std::process::exit(1);
            });
            jobs.reap();
            let g = Arc::new(Guest {
                machine: false,
                owner: None,
                image: String::new(),
                booted: now_ms(),
                tz: Mutex::new(String::new()),
                jobs,
                connections: AtomicUsize::new(0),
            });
            serve(g, || listener.accept().map(|(c, _)| c));
        }
        #[cfg(target_os = "linux")]
        ["--init", rest @ ..] => {
            let image = init::boot(rest.contains(&"--rooted"));
            jobs.reap();
            let g = Arc::new(Guest {
                machine: true,
                owner: Some((1000, 1000)),
                image,
                booted: now_ms(),
                tz: Mutex::new(String::new()),
                jobs,
                connections: AtomicUsize::new(0),
            });
            if let Err(e) = egress::serve() {
                eprintln!("bigbrain-guest: egress forwarder: {e}");
            }
            let listener = vsock::Listener::bind(GUEST_PORT).unwrap_or_else(|e| init::fatal(&format!("can't listen on vsock {GUEST_PORT}: {e}")));
            eprintln!("bigbrain-guest {VERSION}: serving on vsock {GUEST_PORT}");
            serve(g, || listener.accept());
        }
        _ => usage(),
    }
}
