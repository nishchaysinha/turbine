//! Builds the shell command line for an agent from a preset template.
//!
//! Templates look like `claude -p "{{task.title}}. {{task.description}}"` and
//! the values come from users (task titles, prompts, review notes from the
//! phone). They are typed into an interactive shell, so every value must be
//! escaped for the quoting context its placeholder sits in; otherwise a prompt
//! containing `"`, `$(...)` or a backtick breaks the command or runs code.

use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Quote {
    None,
    Single,
    Double,
}

/// Escapes `value` for the given quoting context in a POSIX shell (bash/zsh/sh).
fn escape_posix(value: &str, ctx: Quote) -> String {
    match ctx {
        // '…' can't contain a quote: close, emit an escaped quote, reopen.
        Quote::Single => value.replace('\'', r"'\''"),
        // "…" still expands $ ` \ and (interactively) ! history references.
        Quote::Double => {
            let mut out = String::with_capacity(value.len());
            for ch in value.chars() {
                match ch {
                    '\\' | '"' | '$' | '`' => {
                        out.push('\\');
                        out.push(ch);
                    }
                    // `\!` keeps the backslash in bash, so step outside the quotes.
                    '!' => out.push_str(r#""'!'""#),
                    _ => out.push(ch),
                }
            }
            out
        }
        // Bare placeholder: make the value a single quoted word.
        Quote::None => format!("'{}'", value.replace('\'', r"'\''")),
    }
}

/// cmd.exe has no real escaping inside quotes; keep the value on one line and
/// use the MSVCRT `\"` convention most CLIs understand.
fn escape_windows(value: &str, ctx: Quote) -> String {
    let flat = value.replace(['\r', '\n'], " ");
    match ctx {
        Quote::Double => flat.replace('"', "\\\""),
        _ => format!("\"{}\"", flat.replace('"', "\\\"")),
    }
}

fn resolve_with(template: &str, vars: &HashMap<&str, &str>, windows: bool) -> String {
    let mut out = String::with_capacity(template.len());
    let mut ctx = Quote::None;
    let bytes = template.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if template[i..].starts_with("{{") {
            if let Some(end) = template[i + 2..].find("}}") {
                let key = template[i + 2..i + 2 + end].trim();
                if let Some(value) = vars.get(key) {
                    out.push_str(&if windows { escape_windows(value, ctx) } else { escape_posix(value, ctx) });
                    i += end + 4;
                    continue;
                }
            }
        }

        let ch = template[i..].chars().next().unwrap();
        match (ch, ctx) {
            ('"', Quote::None) => ctx = Quote::Double,
            ('"', Quote::Double) => ctx = Quote::None,
            ('\'', Quote::None) if !windows => ctx = Quote::Single,
            ('\'', Quote::Single) => ctx = Quote::None,
            // A backslash escapes the next char outside single quotes.
            ('\\', c) if c != Quote::Single && !windows => {
                out.push(ch);
                i += 1;
                if let Some(next) = template[i..].chars().next() {
                    out.push(next);
                    i += next.len_utf8();
                }
                continue;
            }
            _ => {}
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Substitutes `{{key}}` placeholders, escaping each value for the shell.
/// Unknown placeholders are left untouched.
pub fn resolve_template(template: &str, vars: &HashMap<&str, &str>) -> String {
    resolve_with(template, vars, cfg!(windows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn vars<'a>(pairs: &[(&'a str, &'a str)]) -> HashMap<&'a str, &'a str> {
        pairs.iter().copied().collect()
    }

    /// Runs the resolved command through a real shell and returns what `printf` saw.
    fn shell_echo(template: &str, value: &str) -> String {
        let cmd = resolve_with(template, &vars(&[("prompt", value)]), false);
        let out = Command::new("sh").arg("-c").arg(&cmd).output().expect("sh");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[test]
    fn substitutes_plain_values() {
        let t = r#"claude -p "{{task.title}}. {{task.description}}""#;
        let v = vars(&[("task.title", "Fix login"), ("task.description", "use JWT")]);
        assert_eq!(resolve_with(t, &v, false), r#"claude -p "Fix login. use JWT""#);
    }

    #[test]
    fn values_survive_a_real_shell_unchanged() {
        let nasty = "say \"hi\" $(touch /tmp/turbine-pwned) `id` $HOME back\\slash it's done! 100%\nline two";
        for template in [r#"printf %s "{{prompt}}""#, "printf %s '{{prompt}}'", "printf %s {{prompt}}"] {
            assert_eq!(shell_echo(template, nasty), nasty, "template {template}");
        }
        assert!(!std::path::Path::new("/tmp/turbine-pwned").exists(), "command substitution ran");
    }

    #[test]
    fn leaves_unknown_placeholders_and_escaped_quotes_alone() {
        let t = r#"run \"literal\" {{unknown}} "{{prompt}}""#;
        assert_eq!(resolve_with(t, &vars(&[("prompt", "a$b")]), false), r#"run \"literal\" {{unknown}} "a\$b""#);
    }

    #[test]
    fn windows_keeps_one_line_and_escapes_quotes() {
        let t = r#"codex "{{prompt}}""#;
        assert_eq!(resolve_with(t, &vars(&[("prompt", "say \"hi\"\nnow")]), true), r#"codex "say \"hi\" now""#);
        assert_eq!(resolve_with("codex {{prompt}}", &vars(&[("prompt", "a b")]), true), r#"codex "a b""#);
    }
}
