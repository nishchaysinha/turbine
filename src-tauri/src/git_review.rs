//! Diffs for code review, in the scopes Orca's review panel offers.
//!
//! `get_git_diff` only ever showed unstaged edits, so staged work and brand
//! new files (the bulk of what agents produce) were invisible. This returns
//! one unified diff for the requested scope, with untracked files rendered as
//! additions.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

const MAX_UNTRACKED_FILES: usize = 200;
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitReview {
    pub scope: String,
    pub diff: String,
    /// Base the branch scope compares against (e.g. `origin/main`).
    pub base: Option<String>,
    pub branch: Option<String>,
    pub truncated: bool,
    pub untracked: usize,
}

fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))
}

fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(cwd, args)?;
    if !out.status.success() {
        return Err(format!("Git error: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Untracked (not ignored) files rendered as `new file` diffs.
fn untracked_diff(cwd: &Path) -> Result<(String, usize), String> {
    let list = git_ok(cwd, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let files: Vec<&str> = list.split('\0').filter(|f| !f.is_empty()).collect();
    let mut out = String::new();
    for file in files.iter().take(MAX_UNTRACKED_FILES) {
        // `--no-index` exits 1 when the files differ, which is always here.
        let res = git(cwd, &["diff", "--no-color", "--no-index", "--", "/dev/null", file])?;
        out.push_str(&String::from_utf8_lossy(&res.stdout));
        if out.len() > MAX_DIFF_BYTES {
            break;
        }
    }
    Ok((out, files.len()))
}

/// The branch's upstream/default base: origin/HEAD, then main/master.
fn default_base(cwd: &Path) -> Option<String> {
    if let Ok(head) = git_ok(cwd, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        let head = head.trim();
        if !head.is_empty() {
            return Some(head.to_string());
        }
    }
    for candidate in ["origin/main", "origin/master", "main", "master"] {
        if git(cwd, &["rev-parse", "--verify", "--quiet", candidate]).map(|o| o.status.success()).unwrap_or(false) {
            return Some(candidate.to_string());
        }
    }
    None
}

pub fn review(path: &Path, scope: &str) -> Result<GitReview, String> {
    let branch = git_ok(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().map(|s| s.trim().to_string());
    let has_head = git(path, &["rev-parse", "--verify", "--quiet", "HEAD"]).map(|o| o.status.success()).unwrap_or(false);
    let mut base = None;
    let mut untracked = 0;

    let mut diff = match scope {
        "unstaged" => git_ok(path, &["diff", "--no-color"])?,
        "staged" => git_ok(path, &["diff", "--no-color", "--cached"])?,
        "branch" => {
            let b = default_base(path).ok_or("No base branch found (looked for origin/HEAD, main, master)")?;
            let merge_base = git_ok(path, &["merge-base", &b, "HEAD"])?;
            base = Some(b);
            git_ok(path, &["diff", "--no-color", merge_base.trim()])?
        }
        // "all": everything not yet committed, including new files.
        _ => {
            let tracked = if has_head {
                git_ok(path, &["diff", "--no-color", "HEAD"])?
            } else {
                git_ok(path, &["diff", "--no-color", "--cached"])?
            };
            tracked
        }
    };
    if scope == "all" || scope == "unstaged" || scope == "branch" {
        let (extra, count) = untracked_diff(path)?;
        untracked = count;
        diff.push_str(&extra);
    }

    let truncated = diff.len() > MAX_DIFF_BYTES || untracked > MAX_UNTRACKED_FILES;
    if diff.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
    }

    Ok(GitReview {
        scope: if ["unstaged", "staged", "branch"].contains(&scope) { scope.to_string() } else { "all".to_string() },
        diff,
        base,
        branch,
        truncated,
        untracked,
    })
}

#[tauri::command]
pub fn get_git_review(path: String, scope: Option<String>) -> Result<GitReview, String> {
    review(Path::new(&path), scope.as_deref().unwrap_or("all"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, script: &str) {
        let ok = Command::new("sh").arg("-c").arg(script).current_dir(dir).status().unwrap().success();
        assert!(ok, "script failed: {script}");
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        sh(
            dir.path(),
            "git init -q -b main && git config user.email t@t && git config user.name t && \
             printf 'a\\nb\\n' > keep.txt && printf 'x\\n' > staged.txt && git add -A && git commit -qm init && \
             git checkout -qb feature && printf 'a\\nB\\n' > keep.txt && git commit -qam change && \
             printf 'a\\nB\\nc\\n' > keep.txt && printf 'y\\n' > staged.txt && git add staged.txt && \
             mkdir -p src && printf 'new\\n' > src/new.txt && printf 'ignored\\n' > skip.log && echo '*.log' > .gitignore",
        );
        dir
    }

    #[test]
    fn all_scope_includes_staged_unstaged_and_untracked() {
        let r = repo();
        let all = review(r.path(), "all").unwrap();
        assert!(all.diff.contains("+++ b/keep.txt"));
        assert!(all.diff.contains("+++ b/staged.txt"));
        assert!(all.diff.contains("+++ b/src/new.txt"), "untracked files appear as new files");
        assert!(!all.diff.contains("skip.log"), "ignored files are excluded");
        assert_eq!(all.branch.as_deref(), Some("feature"));
    }

    #[test]
    fn scopes_split_staged_from_unstaged_and_branch_uses_merge_base() {
        let r = repo();
        let staged = review(r.path(), "staged").unwrap();
        assert!(staged.diff.contains("staged.txt") && !staged.diff.contains("keep.txt"));
        let unstaged = review(r.path(), "unstaged").unwrap();
        assert!(unstaged.diff.contains("keep.txt") && !unstaged.diff.contains("+y"));
        let branch = review(r.path(), "branch").unwrap();
        assert_eq!(branch.base.as_deref(), Some("main"));
        assert!(branch.diff.contains("-b") && branch.diff.contains("+B"), "includes the committed branch change");
    }

    #[test]
    fn errors_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(review(dir.path(), "all").is_err());
    }
}
