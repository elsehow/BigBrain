//! The machine's only way out: 127.0.0.1:3128 joined to the host's egress
//! proxy over vsock (PROTOCOL.md, Egress). Unframed, end to end.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;

pub const LISTEN: &str = "127.0.0.1:3128";
pub const HOST_PORT: u32 = 7471;

pub fn serve() -> io::Result<()> {
    let listener = TcpListener::bind(LISTEN)?;
    std::thread::spawn(move || {
        for tcp in listener.incoming().flatten() {
            std::thread::spawn(move || {
                if let Ok(up) = crate::vsock::connect(crate::vsock::HOST_CID, HOST_PORT) {
                    splice(tcp, up);
                }
            });
        }
    });
    Ok(())
}

/// Copy both ways until both sides are done; each half closes the other's write side.
pub fn splice(tcp: TcpStream, unix: UnixStream) {
    let (mut t2, mut u2) = match (tcp.try_clone(), unix.try_clone()) {
        (Ok(t), Ok(u)) => (t, u),
        _ => return,
    };
    let back = std::thread::spawn(move || {
        let _ = copy(&mut u2, &mut t2);
        let _ = t2.shutdown(Shutdown::Write);
    });
    let (mut t, mut u) = (tcp, unix);
    let _ = copy(&mut t, &mut u);
    let _ = u.shutdown(Shutdown::Write);
    let _ = back.join();
}

fn copy(from: &mut impl Read, to: &mut impl Write) -> io::Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        to.write_all(&buf[..n])?;
    }
}
