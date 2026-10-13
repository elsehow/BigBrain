//! Listening TCP sockets, and the process group of whoever holds each.

pub struct Listener {
    pub port: u16,
    pub pid: i32,
    pub pgid: i32,
}

#[cfg(target_os = "linux")]
pub fn listeners() -> Vec<Listener> {
    use std::collections::HashMap;
    use std::fs;
    // inode → port, from every listening socket (state 0A)
    let mut by_inode: HashMap<u64, u16> = HashMap::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(table) else { continue };
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                continue;
            }
            let Some(port) = f[1].rsplit(':').next().and_then(|p| u16::from_str_radix(p, 16).ok()) else { continue };
            if let Ok(inode) = f[9].parse::<u64>() {
                if inode != 0 {
                    by_inode.insert(inode, port);
                }
            }
        }
    }
    let mut out = Vec::new();
    if by_inode.is_empty() {
        return out;
    }
    let Ok(procs) = fs::read_dir("/proc") else { return out };
    for p in procs.flatten() {
        let Ok(pid) = p.file_name().to_string_lossy().parse::<i32>() else { continue };
        let Ok(fds) = fs::read_dir(p.path().join("fd")) else { continue };
        let mut pgid = None;
        for fd in fds.flatten() {
            let Ok(link) = fs::read_link(fd.path()) else { continue };
            let link = link.to_string_lossy();
            let Some(inode) = link.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')).and_then(|s| s.parse::<u64>().ok()) else { continue };
            let Some(&port) = by_inode.get(&inode) else { continue };
            let g = *pgid.get_or_insert_with(|| group_of(pid));
            if !out.iter().any(|l: &Listener| l.port == port && l.pid == pid) {
                out.push(Listener { port, pid, pgid: g });
            }
        }
    }
    out.sort_by_key(|l| (l.port, l.pid));
    out
}

#[cfg(target_os = "linux")]
fn group_of(pid: i32) -> i32 {
    // field 5 of /proc/<pid>/stat, counted after the command's closing paren
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| s.rsplit_once(')').map(|(_, rest)| rest.to_string()))
        .and_then(|rest| rest.split_whitespace().nth(2).and_then(|g| g.parse().ok()))
        .unwrap_or(0)
}

/// Elsewhere (a sandboxed guest on macOS): lsof, and each pid's group from the kernel.
#[cfg(not(target_os = "linux"))]
pub fn listeners() -> Vec<Listener> {
    let mut out = Vec::new();
    let lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].into_iter().find(|p| std::path::Path::new(p).exists()).unwrap_or("lsof");
    let Ok(o) = std::process::Command::new(lsof).args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).output() else { return out };
    let mut pid = 0;
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().unwrap_or(0);
        } else if let Some(n) = line.strip_prefix('n') {
            let Some(port) = n.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
            if pid > 0 && !out.iter().any(|l: &Listener| l.port == port && l.pid == pid) {
                out.push(Listener { port, pid, pgid: unsafe { libc::getpgid(pid) } });
            }
        }
    }
    out.sort_by_key(|l| (l.port, l.pid));
    out
}
