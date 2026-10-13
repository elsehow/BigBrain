//! PID 1: from the initramfs onto the machine's disk (the plan's "Boot").
//!
//! Stage one runs from the initramfs: mount the basics, load the kernel
//! modules listed in /modules/order, bring up loopback, mount /dev/vda,
//! copy this binary to the disk's /run (a tmpfs), and switch root onto the
//! disk. An initramfs can't be pivot_root'ed away, so this is switch_root's
//! dance: empty the initramfs, move the new root over /, chroot. Stage two
//! is this binary exec'd again from /run, with `--rooted`.

use std::ffi::CString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

const NEWROOT: &str = "/newroot";
const DISK: &str = "/dev/vda";
const SELF_ON_DISK: &str = "/run/bigbrain-guest";

pub fn fatal(msg: &str) -> ! {
    eprintln!("bigbrain-guest: {msg}");
    // PID 1 exiting panics the kernel; power off instead, so the helper sees the machine stop
    std::thread::sleep(Duration::from_millis(200));
    unsafe {
        libc::sync();
        libc::reboot(libc::RB_POWER_OFF);
    }
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

fn c(s: &str) -> CString {
    CString::new(s).unwrap()
}

fn mount(src: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: &str) -> std::io::Result<()> {
    let _ = fs::create_dir_all(target);
    let (s, t, f, d) = (c(src), c(target), c(fstype), c(data));
    let r = unsafe {
        libc::mount(
            s.as_ptr(),
            t.as_ptr(),
            if fstype.is_empty() { std::ptr::null() } else { f.as_ptr() },
            flags,
            if data.is_empty() { std::ptr::null() } else { d.as_ptr() as *const libc::c_void },
        )
    };
    if r < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn must(what: &str, r: std::io::Result<()>) {
    if let Err(e) = r {
        fatal(&format!("{what}: {e}"));
    }
}

/// Load each module in the manifest's order; one already built in is fine.
fn modules() {
    let Ok(order) = fs::read_to_string("/modules/order") else { return };
    for name in order.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let path = format!("/modules/{name}");
        let Ok(f) = fs::File::open(&path) else {
            eprintln!("bigbrain-guest: module {name} is missing");
            continue;
        };
        use std::os::fd::AsRawFd;
        let empty = c("");
        let r = unsafe { libc::syscall(libc::SYS_finit_module, f.as_raw_fd(), empty.as_ptr(), 0) };
        if r < 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EEXIST) {
                eprintln!("bigbrain-guest: module {name}: {e}");
            }
        }
    }
}

/// Bring up loopback: the only interface a machine has.
fn loopback() {
    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return;
        }
        let mut ifr: libc::ifreq = std::mem::zeroed();
        for (i, b) in b"lo\0".iter().enumerate() {
            ifr.ifr_name[i] = *b as libc::c_char;
        }
        if libc::ioctl(fd, libc::SIOCGIFFLAGS, &mut ifr) == 0 {
            ifr.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
            libc::ioctl(fd, libc::SIOCSIFFLAGS, &ifr);
        }
        libc::close(fd);
    }
}

/// Remove the initramfs's files (it is RAM), not crossing into other mounts.
fn empty_initramfs(dir: &Path, dev: u64) {
    use std::os::unix::fs::MetadataExt;
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(m) = fs::symlink_metadata(&p) else { continue };
        if m.dev() != dev {
            continue;
        }
        if m.is_dir() {
            empty_initramfs(&p, dev);
            let _ = fs::remove_dir(&p);
        } else {
            let _ = fs::remove_file(&p);
        }
    }
}

fn stage_one() -> ! {
    must("mount /proc", mount("proc", "/proc", "proc", 0, ""));
    must("mount /sys", mount("sysfs", "/sys", "sysfs", 0, ""));
    must("mount /dev", mount("devtmpfs", "/dev", "devtmpfs", 0, ""));
    modules();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !Path::new(DISK).exists() {
        if Instant::now() > deadline {
            fatal(&format!("{DISK} never appeared: is virtio_blk in the module set?"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    must("mount the disk", mount(DISK, NEWROOT, "ext4", libc::MS_NOATIME, ""));
    must("mount /run", mount("tmpfs", &format!("{NEWROOT}/run"), "tmpfs", libc::MS_NOSUID | libc::MS_NODEV, "mode=0755"));
    must("copy the guest", fs::copy("/proc/self/exe", format!("{NEWROOT}{SELF_ON_DISK}")).map(|_| ()));
    for m in ["/proc", "/sys", "/dev"] {
        must(&format!("move {m}"), mount(m, &format!("{NEWROOT}{m}"), "", libc::MS_MOVE, ""));
    }
    use std::os::unix::fs::MetadataExt;
    let dev = fs::metadata("/").map(|m| m.dev()).unwrap_or(0);
    empty_initramfs(Path::new("/"), dev);
    must("chdir", std::env::set_current_dir(NEWROOT));
    must("switch root", mount(".", "/", "", libc::MS_MOVE, ""));
    let dot = c(".");
    if unsafe { libc::chroot(dot.as_ptr()) } < 0 {
        fatal(&format!("chroot: {}", std::io::Error::last_os_error()));
    }
    must("chdir /", std::env::set_current_dir("/"));
    use std::os::unix::process::CommandExt;
    let e = std::process::Command::new(SELF_ON_DISK).args(["--init", "--rooted"]).exec();
    fatal(&format!("exec {SELF_ON_DISK}: {e}"))
}

/// Stage two, on the disk: what the machine needs before it serves. Returns the image's name.
fn stage_two() -> String {
    let _ = mount("devpts", "/dev/pts", "devpts", libc::MS_NOSUID | libc::MS_NOEXEC, "gid=5,mode=620,ptmxmode=666");
    let _ = mount("tmpfs", "/dev/shm", "tmpfs", libc::MS_NOSUID | libc::MS_NODEV, "mode=1777");
    let _ = fs::set_permissions("/tmp", std::os::unix::fs::PermissionsExt::from_mode(0o1777));
    loopback();
    let host = c("desktop");
    unsafe { libc::sethostname(host.as_ptr(), 7) };
    for dir in ["/work", "/work/.in", "/work/.out"] {
        if fs::create_dir_all(dir).is_ok() {
            let _ = std::os::unix::fs::chown(dir, Some(1000), Some(1000));
        }
    }
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    fs::read_to_string("/etc/bigbrain-image").map(|s| s.trim().chars().take(128).collect()).unwrap_or_default()
}

/// PID 1's start. Returns, on the disk, the image's name.
pub fn boot(rooted: bool) -> String {
    if std::process::id() != 1 {
        fatal("--init runs only as PID 1");
    }
    if !rooted {
        stage_one();
    }
    stage_two()
}

/// Every process gone, the disk clean, the machine off.
pub fn power_off() -> ! {
    unsafe {
        libc::kill(-1, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(500));
    unsafe {
        libc::kill(-1, libc::SIGKILL);
        libc::sync();
    }
    let _ = mount("", "/", "", libc::MS_REMOUNT | libc::MS_RDONLY, "");
    let _ = std::io::stderr().flush();
    unsafe {
        libc::sync();
        libc::reboot(libc::RB_POWER_OFF);
    }
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
