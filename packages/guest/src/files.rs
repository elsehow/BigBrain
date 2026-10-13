//! stat, list, read and write, on the guest's own disk (PROTOCOL.md).

use crate::frame::{self, Frame, FrameError};
use crate::proto::{bad, err, Error, Req};
use crate::Guest;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const READ_MAX: u64 = 64 * 1024 * 1024;
pub const WRITE_MAX: u64 = 256 * 1024 * 1024;
pub const LIST_MAX: usize = 10_000;

pub fn hex(d: impl AsRef<[u8]>) -> String {
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn kind(t: fs::FileType) -> &'static str {
    if t.is_symlink() {
        "link"
    } else if t.is_dir() {
        "dir"
    } else if t.is_file() {
        "file"
    } else {
        "other"
    }
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(h.finalize()))
}

pub fn stat(req: &Req) -> Result<Value, Error> {
    let path = req.path("path")?;
    let m = fs::symlink_metadata(&path)?;
    let mtime = m.mtime() as i128 * 1000 + m.mtime_nsec() as i128 / 1_000_000;
    let mut out = json!({ "ok": true, "kind": kind(m.file_type()), "size": m.size(), "mtime": mtime.max(0) as u64, "mode": m.mode() & 0o7777 });
    if req.bool("hash") && m.is_file() && m.size() <= READ_MAX {
        out["sha256"] = json!(sha256_of(Path::new(&path))?);
    }
    Ok(out)
}

pub fn list(req: &Req) -> Result<Value, Error> {
    let path = req.path("path")?;
    if !fs::metadata(&path)?.is_dir() {
        return Err(err("not-directory", "not a folder"));
    }
    let mut entries: Vec<(String, &'static str)> = Vec::new();
    let mut truncated = false;
    for e in fs::read_dir(&path)? {
        let e = e?;
        if entries.len() == LIST_MAX {
            truncated = true;
            break;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        entries.push((name, e.file_type().map(kind).unwrap_or("other")));
    }
    entries.sort();
    let list: Vec<Value> = entries.into_iter().map(|(name, kind)| json!({ "name": name, "kind": kind })).collect();
    let mut out = json!({ "ok": true, "entries": list });
    if truncated {
        out["truncated"] = json!(true);
    }
    Ok(out)
}

/// `read`: the answer, then data frames. Returns only once both are written.
pub fn read<W: Write>(req: &Req, w: &mut W) -> Result<(), Error> {
    let path = req.path("path")?;
    let mut f = File::open(&path)?;
    let m = f.metadata()?;
    if m.is_dir() {
        return Err(err("is-directory", "a folder; use list"));
    }
    let size = m.size();
    let offset = req.int("offset").min(size);
    let length = req.int("length").min(size - offset);
    if length > READ_MAX {
        return Err(err("too-large", format!("reads are at most {READ_MAX} bytes")));
    }
    if size <= READ_MAX {
        let mut body = Vec::with_capacity(size as usize);
        f.read_to_end(&mut body)?;
        let sha = hex(Sha256::digest(&body));
        let end = (offset + length).min(body.len() as u64) as usize;
        let part = &body[offset as usize..end];
        frame::write_control(w, &json!({ "ok": true, "size": size, "length": part.len(), "sha256": sha }))?;
        frame::write_data(w, frame::DATA, part)?;
    } else {
        f.seek(SeekFrom::Start(offset))?;
        frame::write_control(w, &json!({ "ok": true, "size": size, "length": length }))?;
        let mut left = length;
        let mut buf = vec![0u8; frame::DATA_CAP];
        while left > 0 {
            let want = left.min(buf.len() as u64) as usize;
            let n = f.read(&mut buf[..want])?;
            if n == 0 {
                // the file shrank under us: pad, so the host's count holds
                buf[..want].fill(0);
                frame::write_bytes(w, frame::DATA, &buf[..want])?;
                left -= want as u64;
                continue;
            }
            frame::write_bytes(w, frame::DATA, &buf[..n])?;
            left -= n as u64;
        }
    }
    Ok(())
}

/// Where a write lands: a link is followed to what it names.
fn target(path: &str) -> Result<PathBuf, Error> {
    let p = PathBuf::from(path);
    match fs::symlink_metadata(&p) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(&p).map_err(|_| bad("a broken link")),
        Ok(m) if m.is_dir() => Err(err("is-directory", "a folder")),
        _ => Ok(p),
    }
}

/// Create `dir` and its missing parents, each given to `owner`.
fn make_dirs(dir: &Path, owner: Option<(u32, u32)>) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        make_dirs(parent, owner)?;
    }
    match fs::create_dir(dir) {
        Ok(()) => {
            if let Some((u, g)) = owner {
                std::os::unix::fs::chown(dir, Some(u), Some(g))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

/// `write`: the data frames that follow the request, to a temp file, renamed into place.
pub fn write<S: Read + Write>(g: &Guest, req: &Req, s: &mut S) -> Result<Value, Error> {
    let path = req.path("path")?;
    let size = req.int("size");
    if size > WRITE_MAX {
        return Err(err("too-large", format!("writes are at most {WRITE_MAX} bytes")));
    }
    let dest = target(&path)?;
    let parent = dest.parent().ok_or_else(|| bad("no parent folder"))?.to_path_buf();
    if !parent.is_dir() {
        if req.bool("parents") {
            make_dirs(&parent, g.owner)?;
        } else if parent.exists() {
            return Err(err("not-directory", "the parent is not a folder"));
        } else {
            return Err(err("not-found", "the parent folder does not exist"));
        }
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = parent.join(format!(".{name}.bigbrain-{}-{}", std::process::id(), crate::unique()));
    let mode = req.opt_int("mode").map(|m| m as u32 & 0o7777).or_else(|| fs::metadata(&dest).ok().map(|m| m.mode() & 0o7777)).unwrap_or(0o644);
    let result = (|| -> Result<String, Error> {
        let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        let mut h = Sha256::new();
        let mut got = 0u64;
        while got < size {
            match frame::read(s) {
                Ok(Frame::Bytes(frame::DATA, chunk)) => {
                    if got + chunk.len() as u64 > size {
                        return Err(bad("more data than size"));
                    }
                    got += chunk.len() as u64;
                    h.update(&chunk);
                    f.write_all(&chunk)?;
                }
                Ok(_) => return Err(bad("a write is followed only by data frames")),
                Err(FrameError::Closed) => return Err(bad("the connection closed mid-write")),
                Err(e) => return Err(bad(format!("{e:?}"))),
            }
        }
        f.set_permissions(fs::Permissions::from_mode(mode))?;
        if let Some((u, gid)) = g.owner {
            std::os::unix::fs::fchown(&f, Some(u), Some(gid))?;
        }
        drop(f);
        match req.raw("ifMatch") {
            Some(Value::Null) if fs::symlink_metadata(&dest).is_ok() => return Err(err("conflict", "the file exists")),
            Some(Value::String(want)) => {
                let have = sha256_of(&dest).map_err(|_| err("conflict", "the file is gone"))?;
                if &have != want {
                    return Err(err("conflict", "the file changed"));
                }
            }
            _ => {}
        }
        fs::rename(&tmp, &dest)?;
        Ok(hex(h.finalize()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(json!({ "ok": true, "sha256": result? }))
}
