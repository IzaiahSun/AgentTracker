//! Maps a session's working directory to the project it belongs to.
//!
//! Subdirectories resolve to the enclosing git repository, and git worktrees
//! (including deleted Claude Code worktrees) resolve to their main checkout.
//! Scratch locations collapse into a few buckets.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Temporary and scratch directories.
pub const TEMP: &str = "<temp>";
/// Claude Cowork sandboxes.
pub const COWORK: &str = "<cowork>";

pub struct Resolver {
    home: PathBuf,
    memo: HashMap<String, String>,
}

impl Resolver {
    pub fn new() -> Self {
        Resolver {
            home: dirs::home_dir().unwrap_or_default(),
            memo: HashMap::new(),
        }
    }

    /// Returns the project path for `cwd`, or "" when unknown.
    pub fn resolve(&mut self, cwd: Option<&str>) -> String {
        let Some(cwd) = cwd.map(clean).filter(|c| !c.is_empty()) else {
            return String::new();
        };
        if let Some(p) = self.memo.get(&cwd) {
            return p.clone();
        }
        let p = self.compute(&cwd);
        self.memo.insert(cwd, p.clone());
        p
    }

    fn compute(&self, cwd: &str) -> String {
        let unix = cwd.replace('\\', "/");
        // Cowork runs in a VM whose working dirs are `/sessions/<name>`.
        if unix.contains("/local-agent-mode-sessions/") || unix.starts_with("/sessions/") {
            return COWORK.into();
        }
        if is_temp(&unix) || unix.contains("/Claude/scratch-workspaces/") {
            return TEMP.into();
        }
        // Claude Code worktrees live inside the repo and are often deleted later.
        if let Some(i) = unix.find("/.claude/worktrees/") {
            return cwd[..i].to_string();
        }
        let mut p = Path::new(cwd);
        loop {
            if p == self.home {
                break;
            }
            let git = p.join(".git");
            if git.is_dir() {
                return p.display().to_string();
            }
            if git.is_file() {
                return worktree_main(&git).unwrap_or_else(|| p.display().to_string());
            }
            match p.parent() {
                Some(parent) => p = parent,
                None => break,
            }
        }
        cwd.to_string()
    }
}

fn clean(s: &str) -> String {
    let s = s.trim().strip_prefix("file://").unwrap_or(s.trim());
    let t = s.trim_end_matches(['/', '\\']);
    if t.is_empty() { s.to_string() } else { t.to_string() }
}

fn is_temp(unix: &str) -> bool {
    const PREFIXES: [&str; 4] = ["/tmp", "/private/tmp", "/var/folders/", "/private/var/folders/"];
    if PREFIXES.iter().any(|p| unix == *p || unix.starts_with(&format!("{}/", p.trim_end_matches('/')))) {
        return true;
    }
    let tmp = std::env::temp_dir().display().to_string().replace('\\', "/");
    let tmp = tmp.trim_end_matches('/');
    !tmp.is_empty() && unix.starts_with(tmp)
}

/// A `.git` file in a linked worktree reads `gitdir: <main>/.git/worktrees/<name>`.
fn worktree_main(git_file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(git_file).ok()?;
    let dir = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let unix = dir.replace('\\', "/");
    let i = unix.find("/.git/worktrees/")?;
    Some(dir[..i].to_string())
}
