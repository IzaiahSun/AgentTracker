pub mod claude;
pub mod codex;
pub mod dsh;
pub mod hermes;
pub mod openclaw;
pub mod opencode;
pub mod zcode;

use crate::model::{Event, SourceStatus};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use walkdir::WalkDir;

/// Parsed events per file, reused while the file's mtime and size are unchanged.
#[derive(Default)]
pub struct FileCache {
    map: Mutex<HashMap<PathBuf, (SystemTime, u64, Arc<Vec<Event>>)>>,
}

pub type ParseFn = fn(&Path) -> Result<Vec<Event>, String>;

impl FileCache {
    /// Parses `files` in parallel, skipping files whose cached copy is fresh.
    pub fn parse_all(&self, files: &[PathBuf], parse: ParseFn) -> (Vec<Event>, Vec<String>) {
        let results: Vec<Result<Arc<Vec<Event>>, String>> = files
            .par_iter()
            .map(|path| {
                let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let size = meta.len();
                if let Some((m, s, ev)) = self.map.lock().unwrap().get(path) {
                    if *m == mtime && *s == size {
                        return Ok(ev.clone());
                    }
                }
                let ev = Arc::new(parse(path).map_err(|e| format!("{}: {e}", path.display()))?);
                self.map
                    .lock()
                    .unwrap()
                    .insert(path.clone(), (mtime, size, ev.clone()));
                Ok(ev)
            })
            .collect();

        let mut events = Vec::new();
        let mut errors = Vec::new();
        for r in results {
            match r {
                Ok(ev) => events.extend(ev.iter().cloned()),
                Err(e) => errors.push(e),
            }
        }
        (events, errors)
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Returns `$VAR` (if set) followed by the defaults, keeping only existing dirs.
pub fn roots(env_var: &str, defaults: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var(env_var) {
        for p in std::env::split_paths(&v) {
            out.push(p);
        }
    }
    out.extend(defaults);
    existing_dirs(out)
}

/// Keeps existing directories, dropping duplicates.
pub fn existing_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|p| p.is_dir())
        .filter(|p| seen.insert(p.canonicalize().unwrap_or_else(|_| p.clone())))
        .collect()
}

/// Recursively finds files under `roots` accepted by `pred(file_name)`.
pub fn find_files(roots: &[PathBuf], pred: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root).follow_links(false).into_iter().flatten() {
            if entry.file_type().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    if pred(name) {
                        out.push(entry.into_path());
                    }
                }
            }
        }
    }
    out
}

/// Calls `f` for each line of `reader`, tolerating invalid UTF-8 and read errors
/// (e.g. a torn trailing zstd frame): lines read before the error are kept.
pub fn for_each_line(reader: impl Read, mut f: impl FnMut(&str)) {
    let mut r = BufReader::with_capacity(1 << 20, reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim();
                if !line.is_empty() {
                    f(line);
                }
            }
        }
    }
}

pub fn open(path: &Path) -> Result<File, String> {
    File::open(path).map_err(|e| e.to_string())
}

pub fn status(name: &'static str, roots: &[PathBuf], events: usize, errors: Vec<String>) -> SourceStatus {
    SourceStatus {
        agent: name,
        paths: roots.iter().map(|p| p.display().to_string()).collect(),
        found: !roots.is_empty(),
        events,
        errors: errors.into_iter().take(20).collect(),
    }
}

/// Opens a SQLite database read-only without taking write locks.
pub fn open_sqlite(path: &Path) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    Ok(conn)
}

pub fn has_table(conn: &rusqlite::Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}
