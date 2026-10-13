//! AF_VSOCK, as plain file descriptors wrapped in UnixStream: read, write,
//! shutdown and dup are the same system calls whatever the socket's family.

use std::io;
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;

/// The host, as a vsock peer.
pub const HOST_CID: u32 = 2;

fn addr(cid: u32, port: u32) -> libc::sockaddr_vm {
    let mut a: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    a.svm_family = libc::AF_VSOCK as libc::sa_family_t;
    a.svm_cid = cid;
    a.svm_port = port;
    a
}

fn socket() -> io::Result<i32> {
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(fd)
    }
}

pub struct Listener(i32);

impl Listener {
    pub fn bind(port: u32) -> io::Result<Listener> {
        let fd = socket()?;
        let a = addr(libc::VMADDR_CID_ANY, port);
        let size = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
        if unsafe { libc::bind(fd, &a as *const _ as *const libc::sockaddr, size) } < 0 || unsafe { libc::listen(fd, 128) } < 0 {
            let e = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(e);
        }
        Ok(Listener(fd))
    }

    pub fn accept(&self) -> io::Result<UnixStream> {
        loop {
            let fd = unsafe { libc::accept4(self.0, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
            if fd >= 0 {
                return Ok(unsafe { UnixStream::from_raw_fd(fd) });
            }
            let e = io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EINTR) {
                return Err(e);
            }
        }
    }
}

pub fn connect(cid: u32, port: u32) -> io::Result<UnixStream> {
    let fd = socket()?;
    let a = addr(cid, port);
    let size = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
    if unsafe { libc::connect(fd, &a as *const _ as *const libc::sockaddr, size) } < 0 {
        let e = io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(e);
    }
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}
