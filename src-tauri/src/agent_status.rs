//! Agent status hub — the single source of truth for "what is each agent doing".
//!
//! Modeled on Orca's agent-hook server: the app that runs the processes owns
//! agent status in one store, and every reader (the desktop UI, the phone via
//! the P2P bridge) subscribes to it instead of guessing from terminal output.
//!
//! Producers:
//! - **Agent hooks.** Every PTY gets `TURBINE_PANE_ID`, `TURBINE_HOOK_PORT`,
//!   `TURBINE_HOOK_TOKEN` and `TURBINE_HOOK_SCRIPT`. Agent CLIs (Claude Code via
//!   `~/.claude/settings.json` hooks) run the hook script on lifecycle events;
//!   it POSTs the event JSON to the local server below. Outside Turbine the env
//!   vars are absent and the script is a no-op.
//! - **Exit markers.** Swarm agents are typed into an interactive shell, so the
//!   PTY never exits when the agent does. Their command is suffixed with
//!   `; "$TURBINE_HOOK_SCRIPT" exit $?`, which reports the real exit code.
//! - **PTY exit.** Clears the row (the pane is gone).
//!
//! Every change is emitted as `agent_status` / `agent_status_clear` events.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_BODY: usize = 256 * 1024;
const MAX_FIELD: usize = 2000;
const HOOK_SCRIPT_MARKER: &str = "turbine-agent-hook";

/// The four states every reader understands (same vocabulary as Orca).
/// - `working`: the agent is busy on a turn
/// - `blocked`: it needs the user (permission prompt, question)
/// - `waiting`: idle at its prompt, ready for input
/// - `done`: finished — a turn ended (`Stop`) or the process exited
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Blocked,
    Waiting,
    Done,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub pane_id: String,
    pub state: AgentState,
    /// Which agent reported (claude, codex, swarm, …).
    pub agent: String,
    pub prompt: Option<String>,
    pub tool: Option<String>,
    pub tool_input: Option<String>,
    pub message: Option<String>,
    /// Set only when the agent process itself exited.
    pub exit_code: Option<i32>,
    pub session_id: Option<String>,
    pub started_at: u64,
    pub updated_at: u64,
    /// The hook event that produced this row, for diagnostics.
    pub last_event: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClearPayload {
    pane_id: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clip(value: Option<&serde_json::Value>) -> Option<String> {
    let text = match value? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => return None,
        other => other.to_string(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.chars().count() > MAX_FIELD {
        let cut: String = trimmed.chars().take(MAX_FIELD).collect();
        format!("{cut}…")
    } else {
        trimmed.to_string()
    })
}

/// A short, human-readable preview of a tool call's input.
fn tool_preview(input: Option<&serde_json::Value>) -> Option<String> {
    let input = input?;
    for key in ["command", "file_path", "path", "pattern", "url", "description", "prompt"] {
        if let Some(v) = input.get(key) {
            return clip(Some(v));
        }
    }
    clip(Some(input))
}

/// Applies one hook event to the previous row. Returns `None` when the event
/// carries no status change (unknown events are ignored, never rejected).
pub fn apply_event(
    prev: Option<&AgentStatus>,
    pane_id: &str,
    source: &str,
    event: &str,
    payload: &serde_json::Value,
    now: u64,
) -> Option<AgentStatus> {
    let mut next = prev.cloned().unwrap_or(AgentStatus {
        pane_id: pane_id.to_string(),
        state: AgentState::Waiting,
        agent: source.to_string(),
        prompt: None,
        tool: None,
        tool_input: None,
        message: None,
        exit_code: None,
        session_id: None,
        started_at: now,
        updated_at: now,
        last_event: String::new(),
    });
    if source != "turbine" {
        next.agent = source.to_string();
    }
    if let Some(sid) = clip(payload.get("session_id")) {
        next.session_id = Some(sid);
    }

    match event {
        "SessionStart" => {
            next.state = AgentState::Waiting;
            next.exit_code = None;
        }
        "UserPromptSubmit" => {
            next.state = AgentState::Working;
            next.prompt = clip(payload.get("prompt")).or(next.prompt);
            next.tool = None;
            next.tool_input = None;
            next.message = None;
            next.exit_code = None;
            next.started_at = now;
        }
        "PreToolUse" => {
            next.state = AgentState::Working;
            next.tool = clip(payload.get("tool_name"));
            next.tool_input = tool_preview(payload.get("tool_input"));
        }
        "PostToolUse" | "PostToolUseFailure" | "SubagentStart" | "SubagentStop" => {
            // Still mid-turn; a permission prompt that was answered resumes work.
            next.state = AgentState::Working;
        }
        "PermissionRequest" => {
            next.state = AgentState::Blocked;
            next.message = clip(payload.get("message")).or_else(|| {
                clip(payload.get("tool_name")).map(|t| format!("Permission needed for {t}"))
            });
        }
        "Notification" => {
            let kind = payload.get("notification_type").and_then(|v| v.as_str()).unwrap_or("");
            let message = clip(payload.get("message"));
            let lower = message.as_deref().unwrap_or("").to_lowercase();
            if kind == "permission_prompt" || lower.contains("permission") || lower.contains("needs your") {
                next.state = AgentState::Blocked;
            } else if kind == "idle_prompt" || lower.contains("waiting for your input") {
                next.state = AgentState::Waiting;
            } else {
                // Informational: keep the state, surface the message.
                next.message = message;
                next.updated_at = now;
                next.last_event = event.to_string();
                return Some(next);
            }
            next.message = message;
        }
        "Stop" | "StopFailure" | "agent-turn-complete" => {
            next.state = AgentState::Done;
            next.tool = None;
            next.tool_input = None;
            if let Some(msg) = clip(payload.get("last_assistant_message"))
                .or_else(|| clip(payload.get("last-assistant-message")))
                .or_else(|| clip(payload.get("error")))
            {
                next.message = Some(msg);
            }
        }
        "exit" => {
            next.state = AgentState::Done;
            next.tool = None;
            next.tool_input = None;
            next.exit_code = payload
                .get("exit_code")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
                .map(|c| c as i32)
                .or(Some(0));
        }
        _ => return None,
    }

    next.updated_at = now;
    next.last_event = event.to_string();
    Some(next)
}

pub struct AgentStatusHub {
    pub port: u16,
    pub token: String,
    pub script_path: PathBuf,
    rows: Mutex<HashMap<String, AgentStatus>>,
    app: AppHandle,
}

impl AgentStatusHub {
    /// Env vars injected into every PTY so hooks can find us and identify the pane.
    pub fn pty_env(&self, pane_id: &str) -> Vec<(String, String)> {
        if self.port == 0 {
            return vec![];
        }
        vec![
            ("TURBINE_PANE_ID".into(), pane_id.to_string()),
            ("TURBINE_HOOK_PORT".into(), self.port.to_string()),
            ("TURBINE_HOOK_TOKEN".into(), self.token.clone()),
            ("TURBINE_HOOK_SCRIPT".into(), self.script_path.to_string_lossy().into_owned()),
        ]
    }

    pub fn ingest(&self, pane_id: &str, source: &str, event: &str, payload: &serde_json::Value) {
        let next = {
            let Ok(mut rows) = self.rows.lock() else { return };
            let Some(next) = apply_event(rows.get(pane_id), pane_id, source, event, payload, now_ms()) else {
                return;
            };
            rows.insert(pane_id.to_string(), next.clone());
            next
        };
        let _ = self.app.emit("agent_status", next);
    }

    pub fn clear(&self, pane_id: &str) {
        let removed = self.rows.lock().map(|mut rows| rows.remove(pane_id).is_some()).unwrap_or(false);
        if removed {
            let _ = self.app.emit("agent_status_clear", ClearPayload { pane_id: pane_id.to_string() });
        }
    }

    pub fn snapshot(&self) -> Vec<AgentStatus> {
        self.rows.lock().map(|rows| rows.values().cloned().collect()).unwrap_or_default()
    }
}

fn random_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

/// POSIX hook script. Prints `{}` first because Claude treats hook stdout as
/// JSON control output (and some events fail closed on empty stdout).
pub fn posix_hook_script() -> String {
    format!(
        r#"#!/bin/sh
# {HOOK_SCRIPT_MARKER}: reports agent lifecycle events to Turbine.
# Usage: turbine-hook.sh <event> [source]   (event JSON on stdin)
#        turbine-hook.sh exit <code>        (process exit marker)
printf '{{}}\n'
if [ -z "$TURBINE_PANE_ID" ] || [ -z "$TURBINE_HOOK_PORT" ]; then
  [ "$1" = "exit" ] || cat >/dev/null 2>&1
  exit 0
fi
event="$1"
if [ "$event" = "exit" ]; then
  source=turbine
  payload="{{\"exit_code\":${{2:-0}}}}"
else
  source="${{2:-claude}}"
  payload=$(cat 2>/dev/null)
fi
[ -n "$payload" ] || payload='{{}}'
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$payload" | curl -s -m 2 -o /dev/null -X POST \
    -H "Content-Type: application/json" -H "X-Turbine-Token: $TURBINE_HOOK_TOKEN" \
    --data-binary @- \
    "http://127.0.0.1:$TURBINE_HOOK_PORT/hook?pane=$TURBINE_PANE_ID&event=$event&source=$source" \
    >/dev/null 2>&1 || :
fi
exit 0
"#
    )
}

/// Windows variant (curl.exe ships with Windows 10+).
pub fn windows_hook_script() -> String {
    format!(
        "@echo off\r\nrem {HOOK_SCRIPT_MARKER}\r\necho {{}}\r\nif \"%TURBINE_PANE_ID%\"==\"\" exit /b 0\r\nif \"%1\"==\"exit\" (\r\n  curl.exe -s -m 2 -o NUL -X POST -H \"X-Turbine-Token: %TURBINE_HOOK_TOKEN%\" -H \"Content-Type: application/json\" --data \"{{\\\"exit_code\\\":%2}}\" \"http://127.0.0.1:%TURBINE_HOOK_PORT%/hook?pane=%TURBINE_PANE_ID%&event=exit&source=turbine\"\r\n  exit /b 0\r\n)\r\nset SRC=%2\r\nif \"%SRC%\"==\"\" set SRC=claude\r\ncurl.exe -s -m 2 -o NUL -X POST -H \"X-Turbine-Token: %TURBINE_HOOK_TOKEN%\" -H \"Content-Type: application/json\" --data-binary @- \"http://127.0.0.1:%TURBINE_HOOK_PORT%/hook?pane=%TURBINE_PANE_ID%&event=%1&source=%SRC%\"\r\nexit /b 0\r\n"
    )
}

fn write_hook_script(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let (name, body) = if cfg!(windows) {
        ("turbine-hook.cmd", windows_hook_script())
    } else {
        ("turbine-hook.sh", posix_hook_script())
    };
    let path = dir.join(name);
    std::fs::write(&path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            Some((k.to_string(), percent_decode(v)))
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(stream: &mut TcpStream, status: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

/// Handles one hook POST. Separated from the accept loop for testing.
fn handle_connection(mut stream: TcpStream, token: &str, sink: &dyn Fn(&str, &str, &str, serde_json::Value)) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let head_end;
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    head_end = pos + 4;
                    break;
                }
                if raw.len() > MAX_BODY {
                    return respond(&mut stream, "413 Payload Too Large");
                }
            }
        }
    }
    let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "POST" || path != "/hook" {
        return respond(&mut stream, "404 Not Found");
    }
    if headers.get("x-turbine-token").map(String::as_str) != Some(token) {
        return respond(&mut stream, "401 Unauthorized");
    }
    let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if length > MAX_BODY {
        return respond(&mut stream, "413 Payload Too Large");
    }
    let mut body = raw[head_end..].to_vec();
    while body.len() < length {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&buf[..n]),
        }
    }
    let params = parse_query(query);
    let (Some(pane), Some(event)) = (params.get("pane"), params.get("event")) else {
        return respond(&mut stream, "400 Bad Request");
    };
    let source = params.get("source").map(String::as_str).unwrap_or("claude");
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    respond(&mut stream, "204 No Content");
    sink(pane, source, event, payload);
}

/// Starts the hook server and registers the hub as managed state.
pub fn start(app: &AppHandle, data_dir: &Path) {
    let token = random_token();
    let script_path = write_hook_script(&data_dir.join("agent-hooks")).unwrap_or_else(|e| {
        eprintln!("[agent_status] failed to write hook script: {e}");
        PathBuf::new()
    });
    let listener = TcpListener::bind("127.0.0.1:0");
    let port = listener.as_ref().ok().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(0);

    let hub = Arc::new(AgentStatusHub {
        port,
        token: token.clone(),
        script_path,
        rows: Mutex::new(HashMap::new()),
        app: app.clone(),
    });
    app.manage(Arc::clone(&hub));

    match listener {
        Ok(listener) => {
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let hub = Arc::clone(&hub);
                    let token = token.clone();
                    std::thread::spawn(move || {
                        handle_connection(stream, &token, &|pane, source, event, payload| {
                            hub.ingest(pane, source, event, &payload)
                        });
                    });
                }
            });
        }
        Err(e) => eprintln!("[agent_status] hook server failed to start: {e}"),
    }
}

// ── Claude Code hook installation ─────────────────────────────────────

const CLAUDE_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("Notification", false),
    ("Stop", false),
    ("StopFailure", false),
];

fn claude_settings_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("settings.json"));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

fn is_turbine_hook(entry: &serde_json::Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command").and_then(|c| c.as_str()).map(|c| c.contains("turbine-hook")).unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Merges Turbine's hooks into a Claude settings object, replacing older
/// Turbine entries and leaving everything else untouched.
pub fn merge_claude_hooks(settings: &mut serde_json::Value, script: &str, install: bool) {
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    let root = settings.as_object_mut().unwrap();
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, with_matcher) in CLAUDE_EVENTS {
        let list = hooks.entry(event.to_string()).or_insert_with(|| serde_json::json!([]));
        if !list.is_array() {
            *list = serde_json::json!([]);
        }
        let arr = list.as_array_mut().unwrap();
        arr.retain(|e| !is_turbine_hook(e));
        if install {
            let quoted = if cfg!(windows) { format!("\"{script}\"") } else { format!("'{}'", script.replace('\'', r"'\''")) };
            let mut entry = serde_json::json!({
                "hooks": [{ "type": "command", "command": format!("{quoted} {event} claude"), "timeout": 5 }]
            });
            if *with_matcher {
                entry["matcher"] = serde_json::json!("*");
            }
            arr.push(entry);
        }
    }
    hooks.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHooksInfo {
    pub port: u16,
    pub script_path: String,
    pub claude_settings_path: Option<String>,
    pub claude_installed: bool,
}

fn claude_installed(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("hooks").cloned())
        .map(|hooks| {
            CLAUDE_EVENTS.iter().all(|(event, _)| {
                hooks.get(*event).and_then(|l| l.as_array()).map(|a| a.iter().any(is_turbine_hook)).unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn info(hub: &AgentStatusHub) -> AgentHooksInfo {
    let path = claude_settings_path();
    AgentHooksInfo {
        port: hub.port,
        script_path: hub.script_path.to_string_lossy().into_owned(),
        claude_installed: path.as_deref().map(claude_installed).unwrap_or(false),
        claude_settings_path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn agent_status_snapshot(hub: State<'_, Arc<AgentStatusHub>>) -> Vec<AgentStatus> {
    hub.snapshot()
}

/// Lets the frontend report events it observes itself (e.g. a PTY exit).
#[tauri::command]
pub fn agent_status_report(
    pane_id: String,
    event: String,
    payload: Option<serde_json::Value>,
    hub: State<'_, Arc<AgentStatusHub>>,
) {
    hub.ingest(&pane_id, "turbine", &event, &payload.unwrap_or(serde_json::Value::Null));
}

#[tauri::command]
pub fn agent_status_clear(pane_id: String, hub: State<'_, Arc<AgentStatusHub>>) {
    hub.clear(&pane_id);
}

#[tauri::command]
pub fn agent_hooks_info(hub: State<'_, Arc<AgentStatusHub>>) -> AgentHooksInfo {
    info(&hub)
}

/// Installs (or removes) Turbine's status hooks in Claude Code's user settings.
/// The previous file is kept as `settings.json.turbine-backup`.
#[tauri::command]
pub fn agent_hooks_set_claude(install: bool, hub: State<'_, Arc<AgentStatusHub>>) -> Result<AgentHooksInfo, String> {
    let path = claude_settings_path().ok_or("Could not resolve the Claude settings path")?;
    let existing = std::fs::read_to_string(&path).ok();
    let mut settings: serde_json::Value = match &existing {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|e| format!("{} is not valid JSON ({e}); not modifying it", path.display()))?
        }
        _ => serde_json::json!({}),
    };
    merge_claude_hooks(&mut settings, &hub.script_path.to_string_lossy(), install);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(text) = existing {
        let _ = std::fs::write(path.with_extension("json.turbine-backup"), text);
    }
    let pretty = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n").map_err(|e| e.to_string())?;
    Ok(info(&hub))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(events: &[(&str, serde_json::Value)]) -> AgentStatus {
        let mut row: Option<AgentStatus> = None;
        for (i, (event, payload)) in events.iter().enumerate() {
            if let Some(next) = apply_event(row.as_ref(), "p1", "claude", event, payload, i as u64) {
                row = Some(next);
            }
        }
        row.expect("row")
    }

    #[test]
    fn maps_a_claude_turn() {
        let row = run(&[
            ("SessionStart", json!({"session_id": "s1"})),
            ("UserPromptSubmit", json!({"prompt": "add rate limiting"})),
            ("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "pnpm test"}})),
        ]);
        assert_eq!(row.state, AgentState::Working);
        assert_eq!(row.prompt.as_deref(), Some("add rate limiting"));
        assert_eq!(row.tool.as_deref(), Some("Bash"));
        assert_eq!(row.tool_input.as_deref(), Some("pnpm test"));
        assert_eq!(row.session_id.as_deref(), Some("s1"));

        let blocked = run(&[
            ("UserPromptSubmit", json!({"prompt": "x"})),
            ("Notification", json!({"message": "Claude needs your permission to use Bash", "notification_type": "permission_prompt"})),
        ]);
        assert_eq!(blocked.state, AgentState::Blocked);

        let done = run(&[
            ("UserPromptSubmit", json!({"prompt": "x"})),
            ("PreToolUse", json!({"tool_name": "Edit"})),
            ("Stop", json!({"last_assistant_message": "All tests pass."})),
        ]);
        assert_eq!(done.state, AgentState::Done);
        assert_eq!(done.tool, None);
        assert_eq!(done.message.as_deref(), Some("All tests pass."));
        assert_eq!(done.exit_code, None);
    }

    #[test]
    fn exit_marker_records_exit_code_and_unknown_events_are_ignored() {
        let row = run(&[("UserPromptSubmit", json!({})), ("exit", json!({"exit_code": 3}))]);
        assert_eq!(row.state, AgentState::Done);
        assert_eq!(row.exit_code, Some(3));
        assert!(apply_event(None, "p", "claude", "SomeFutureEvent", &json!({}), 0).is_none());
        let info = run(&[("UserPromptSubmit", json!({})), ("Notification", json!({"message": "Compacting"}))]);
        assert_eq!(info.state, AgentState::Working, "informational notifications keep state");
    }

    #[test]
    fn merges_hooks_without_touching_user_entries() {
        let mut settings = json!({
            "model": "opus",
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "say done"}]},
                          {"hooks": [{"type": "command", "command": "/old/turbine-hook.sh Stop claude"}]}]
            }
        });
        merge_claude_hooks(&mut settings, "/data/turbine-hook.sh", true);
        let stop = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "old turbine entry replaced, user entry kept");
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert_eq!(settings["model"], "opus");
        assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "*");

        merge_claude_hooks(&mut settings, "/data/turbine-hook.sh", false);
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(settings["hooks"].get("PreToolUse").is_none());
    }

    #[test]
    fn hook_server_requires_token_and_ingests_events() {
        use std::sync::mpsc;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<(String, String, String, serde_json::Value)>();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten().take(2) {
                let tx = tx.clone();
                handle_connection(stream, "secret", &move |p, s, e, v| {
                    tx.send((p.into(), s.into(), e.into(), v)).unwrap();
                });
            }
        });
        let post = |token: &str| {
            let body = r#"{"prompt":"hi"}"#;
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                s,
                "POST /hook?pane=p%2D1&event=UserPromptSubmit&source=claude HTTP/1.1\r\nX-Turbine-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            let mut resp = String::new();
            let _ = s.read_to_string(&mut resp);
            resp
        };
        assert!(post("wrong").starts_with("HTTP/1.1 401"));
        assert!(post("secret").starts_with("HTTP/1.1 204"));
        let (pane, source, event, payload) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!((pane.as_str(), source.as_str(), event.as_str()), ("p-1", "claude", "UserPromptSubmit"));
        assert_eq!(payload["prompt"], "hi");
    }

    #[test]
    fn posix_script_is_a_noop_outside_turbine() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = write_hook_script(dir.path()).unwrap();
        let out = std::process::Command::new("sh")
            .arg(&path)
            .arg("Stop")
            .env_remove("TURBINE_PANE_ID")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "{}\n");
    }
}
