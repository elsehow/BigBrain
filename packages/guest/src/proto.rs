//! Requests: closed schemas, checked before anything acts on them (PROTOCOL.md, Requests).

use serde_json::{Map, Value};

pub const PROTOCOL: u64 = 1;
pub const PATH_MAX: usize = 4096;
pub const ARGV_MAX: usize = 256;
pub const ARGV_BYTES: usize = 1024 * 1024;
pub const ENV_MAX: usize = 1024;
pub const ENV_BYTES: usize = 128 * 1024;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

pub fn err(code: &'static str, message: impl Into<String>) -> Error {
    Error { code, message: message.into() }
}

pub fn bad(message: impl Into<String>) -> Error {
    err("bad-request", message)
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let code = match e.kind() {
            NotFound => "not-found",
            IsADirectory => "is-directory",
            NotADirectory => "not-directory",
            _ => match e.raw_os_error() {
                Some(libc::ENOTDIR) => "not-directory",
                Some(libc::EISDIR) => "is-directory",
                Some(libc::ENOENT) => "not-found",
                _ => "internal",
            },
        };
        err(code, e.to_string())
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum T {
    Str,
    Int,
    Bool,
    StrList,
    StrMap,
    /// A string, or null.
    StrOrNull,
}

/// One request, its keys checked against the op's schema.
pub struct Req {
    pub op: String,
    pub now: Option<u64>,
    fields: Map<String, Value>,
}

/// Each op's keys: (name, type, required). `op` and `now` are every op's.
fn schema(op: &str) -> Option<&'static [(&'static str, T, bool)]> {
    use T::*;
    Some(match op {
        "hello" => &[("protocol", Int, true), ("tz", Str, true)],
        "exec" => &[("argv", StrList, true), ("cwd", Str, true), ("env", StrMap, true), ("user", Str, true), ("stdin", Bool, true), ("grace", Int, false)],
        "detach" => &[("job", Int, true)],
        "job.stop" => &[("job", Int, true), ("grace", Int, true)],
        "job.list" => &[],
        "job.output" => &[("job", Int, true), ("since", Int, true)],
        "ports" => &[],
        "connect" => &[("port", Int, true)],
        "stat" => &[("path", Str, true), ("hash", Bool, true)],
        "list" => &[("path", Str, true)],
        "read" => &[("path", Str, true), ("offset", Int, true), ("length", Int, true)],
        "write" => &[("path", Str, true), ("size", Int, true), ("mode", Int, false), ("ifMatch", StrOrNull, false), ("parents", Bool, true)],
        "shutdown" => &[],
        _ => return None,
    })
}

fn fits(v: &Value, t: T) -> bool {
    match t {
        T::Str => v.is_string(),
        T::Int => v.is_u64(),
        T::Bool => v.is_boolean(),
        T::StrList => v.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
        T::StrMap => v.as_object().is_some_and(|m| m.values().all(Value::is_string)),
        T::StrOrNull => v.is_string() || v.is_null(),
    }
}

impl Req {
    pub fn parse(v: Value) -> Result<Req, Error> {
        let Value::Object(mut fields) = v else { return Err(bad("a request is a JSON object")) };
        let op = match fields.remove("op") {
            Some(Value::String(s)) => s,
            _ => return Err(bad("a request names its op")),
        };
        let now = match fields.remove("now") {
            None => None,
            Some(n) => Some(n.as_u64().ok_or_else(|| bad("now is ms since the epoch"))?),
        };
        let keys = schema(&op).ok_or_else(|| bad(format!("unknown op {}", clip(&op))))?;
        for k in fields.keys() {
            if !keys.iter().any(|(name, _, _)| name == k) {
                return Err(bad(format!("{op} takes no {}", clip(k))));
            }
        }
        for (name, t, required) in keys {
            match fields.get(*name) {
                None if *required => return Err(bad(format!("{op} needs {name}"))),
                Some(v) if !fits(v, *t) => return Err(bad(format!("{op}: {name} has the wrong type"))),
                _ => {}
            }
        }
        Ok(Req { op, now, fields })
    }

    pub fn str(&self, k: &str) -> &str {
        self.fields.get(k).and_then(Value::as_str).unwrap_or("")
    }
    pub fn int(&self, k: &str) -> u64 {
        self.fields.get(k).and_then(Value::as_u64).unwrap_or(0)
    }
    pub fn opt_int(&self, k: &str) -> Option<u64> {
        self.fields.get(k).and_then(Value::as_u64)
    }
    pub fn bool(&self, k: &str) -> bool {
        self.fields.get(k).and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn list(&self, k: &str) -> Vec<String> {
        self.fields.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
    }
    pub fn map(&self, k: &str) -> Vec<(String, String)> {
        self.fields
            .get(k)
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
            .unwrap_or_default()
    }
    pub fn raw(&self, k: &str) -> Option<&Value> {
        self.fields.get(k)
    }

    /// A path field: absolute, bounded, no NUL.
    pub fn path(&self, k: &str) -> Result<String, Error> {
        let p = self.str(k);
        if p.len() > PATH_MAX {
            return Err(bad(format!("{k} is longer than {PATH_MAX} bytes")));
        }
        if p.contains('\0') {
            return Err(bad(format!("{k} contains NUL")));
        }
        if !p.starts_with('/') {
            return Err(bad(format!("{k} is not absolute")));
        }
        Ok(p.to_string())
    }
}

/// A peer's string, shortened for an error message.
pub fn clip(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(64).collect()
}
