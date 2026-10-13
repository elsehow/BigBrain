//! Frames: `kind: u8`, `length: u32` big-endian, payload (PROTOCOL.md, Frames).

use std::io::{self, Read, Write};

pub const CONTROL: u8 = 0;
pub const STDOUT: u8 = 1;
pub const STDERR: u8 = 2;
pub const STDIN: u8 = 3;
pub const DATA: u8 = 4;

pub const CONTROL_CAP: usize = 256 * 1024;
pub const DATA_CAP: usize = 1024 * 1024;

pub enum Frame {
    Control(serde_json::Value),
    Bytes(u8, Vec<u8>),
}

#[derive(Debug)]
pub enum FrameError {
    /// The peer closed the connection between frames.
    Closed,
    Io(#[allow(dead_code)] io::Error),
    /// An unknown kind, a length over its cap, or a control payload that is not a JSON object.
    Bad(String),
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Closed
        } else {
            FrameError::Io(e)
        }
    }
}

fn cap(kind: u8) -> Option<usize> {
    match kind {
        CONTROL => Some(CONTROL_CAP),
        STDOUT | STDERR | STDIN | DATA => Some(DATA_CAP),
        _ => None,
    }
}

/// Read one frame. The header is checked before the payload is read or allocated.
pub fn read<R: Read>(r: &mut R) -> Result<Frame, FrameError> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        match r.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Err(FrameError::Closed),
            Ok(0) => return Err(FrameError::Bad("truncated frame header".into())),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    let kind = head[0];
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    let max = cap(kind).ok_or_else(|| FrameError::Bad(format!("unknown frame kind {kind}")))?;
    if len > max {
        return Err(FrameError::Bad(format!("frame of {len} bytes is over the {max}-byte cap")));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => FrameError::Bad("truncated frame".into()),
        _ => FrameError::Io(e),
    })?;
    if kind != CONTROL {
        return Ok(Frame::Bytes(kind, payload));
    }
    let text = std::str::from_utf8(&payload).map_err(|_| FrameError::Bad("control frame is not UTF-8".into()))?;
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v @ serde_json::Value::Object(_)) => Ok(Frame::Control(v)),
        Ok(_) => Err(FrameError::Bad("control frame is not a JSON object".into())),
        Err(e) => Err(FrameError::Bad(format!("control frame is not JSON: {e}"))),
    }
}

pub fn write_bytes<W: Write>(w: &mut W, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    Ok(())
}

pub fn write_control<W: Write>(w: &mut W, v: &serde_json::Value) -> io::Result<()> {
    write_bytes(w, CONTROL, v.to_string().as_bytes())
}

/// Write `payload` as data frames of at most `DATA_CAP`.
pub fn write_data<W: Write>(w: &mut W, kind: u8, payload: &[u8]) -> io::Result<()> {
    for chunk in payload.chunks(DATA_CAP) {
        write_bytes(w, kind, chunk)?;
    }
    Ok(())
}
