//! Direct LAN transport for the mobile companion (Orca's desktop serves its
//! phone app the same way: a WebSocket on the local network).
//!
//! WebRTC in the webview is the default transport, but WebKitGTK on Linux is
//! built without it, so phones could never pair with a Linux desktop. This
//! opt-in server speaks the same JSON protocol over `ws://<lan-ip>:<port>`.
//! Every connection must present the session token (`?token=`), checked in
//! the handshake before any message is accepted. Traffic is not encrypted, so
//! the UI labels it for trusted networks only.
//!
//! The webview stays the protocol endpoint: frames are forwarded to it as
//! `companion_lan_message` events and replies go out via `companion_lan_send`.

use serde::Serialize;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

pub const DEFAULT_PORT: u16 = 6970;
const MAX_FRAME: usize = 8 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LanInfo {
    pub running: bool,
    pub port: u16,
    pub token: String,
    /// `ws://` URLs the phone can try, best guess first.
    pub urls: Vec<String>,
    pub clients: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConnEvent {
    conn_id: u64,
    data: Option<String>,
}

struct Server {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, Sender<String>>>>,
}

#[derive(Default)]
pub struct CompanionLan {
    server: Mutex<Option<Server>>,
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The address other devices on the LAN reach us at. Connecting a UDP socket
/// sends nothing; it just makes the OS pick the outbound interface.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.168.0.1:9").or_else(|_| sock.connect("10.0.0.1:9")).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

fn token_from_request(req: &Request) -> Option<String> {
    let query = req.uri().query()?;
    query.split('&').find_map(|kv| kv.strip_prefix("token=").map(|t| t.to_string()))
}

/// Runs one authenticated connection: frames in → events, channel → frames out.
fn serve_connection(
    mut ws: WebSocket<TcpStream>,
    conn_id: u64,
    outbox: Receiver<String>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
) {
    let _ = app.emit("companion_lan_open", ConnEvent { conn_id, data: None });
    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = ws.close(None);
            break;
        }
        while let Ok(text) = outbox.try_recv() {
            if ws.send(Message::Text(text)).is_err() {
                break;
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                let _ = app.emit("companion_lan_message", ConnEvent { conn_id, data: Some(text) });
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    let _ = app.emit("companion_lan_close", ConnEvent { conn_id, data: None });
}

impl CompanionLan {
    pub fn info(&self) -> LanInfo {
        let guard = self.server.lock().unwrap();
        match guard.as_ref() {
            Some(s) => {
                let mut urls = Vec::new();
                if let Some(ip) = lan_ip() {
                    urls.push(format!("ws://{ip}:{}", s.port));
                }
                urls.push(format!("ws://127.0.0.1:{}", s.port));
                LanInfo {
                    running: true,
                    port: s.port,
                    token: s.token.clone(),
                    urls,
                    clients: s.clients.lock().map(|c| c.len()).unwrap_or(0),
                }
            }
            None => LanInfo { running: false, port: 0, token: String::new(), urls: vec![], clients: 0 },
        }
    }

    pub fn start(&self, app: AppHandle, port: u16, token: Option<String>) -> Result<LanInfo, String> {
        self.stop();
        let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("Could not listen on port {port}: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let token = token.filter(|t| t.len() >= 16).unwrap_or_else(new_token);
        let stop = Arc::new(AtomicBool::new(false));
        let clients: Arc<Mutex<HashMap<u64, Sender<String>>>> = Arc::default();

        {
            let (stop, clients, token) = (Arc::clone(&stop), Arc::clone(&clients), token.clone());
            std::thread::spawn(move || {
                let next_id = AtomicU64::new(1);
                while !stop.load(Ordering::Relaxed) {
                    let stream = match listener.accept() {
                        Ok((s, _)) => s,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(100));
                            continue;
                        }
                        Err(_) => continue,
                    };
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(30)));
                    let expected = token.clone();
                    let check = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                        if token_from_request(req).as_deref() == Some(expected.as_str()) {
                            Ok(resp)
                        } else {
                            let mut err = ErrorResponse::new(Some("invalid token".into()));
                            *err.status_mut() = tungstenite::http::StatusCode::UNAUTHORIZED;
                            Err(err)
                        }
                    };
                    let config = tungstenite::protocol::WebSocketConfig {
                        max_message_size: Some(MAX_FRAME),
                        max_frame_size: Some(MAX_FRAME),
                        ..Default::default()
                    };
                    let ws = match tungstenite::accept_hdr_with_config(stream, check, Some(config)) {
                        Ok(ws) => ws,
                        Err(_) => continue, // bad token or not a websocket
                    };
                    let conn_id = next_id.fetch_add(1, Ordering::Relaxed);
                    let (tx, rx) = channel();
                    clients.lock().unwrap().insert(conn_id, tx);
                    let (stop, clients, app) = (Arc::clone(&stop), Arc::clone(&clients), app.clone());
                    std::thread::spawn(move || {
                        serve_connection(ws, conn_id, rx, stop, app);
                        clients.lock().unwrap().remove(&conn_id);
                    });
                }
            });
        }

        *self.server.lock().unwrap() = Some(Server { port, token, stop, clients });
        Ok(self.info())
    }

    pub fn stop(&self) {
        if let Some(server) = self.server.lock().unwrap().take() {
            server.stop.store(true, Ordering::Relaxed);
        }
    }

    pub fn send(&self, data: String) -> usize {
        let guard = self.server.lock().unwrap();
        let Some(server) = guard.as_ref() else { return 0 };
        let clients = server.clients.lock().unwrap();
        clients.values().filter(|tx| tx.send(data.clone()).is_ok()).count()
    }
}

#[tauri::command]
pub fn companion_lan_start(
    port: Option<u16>,
    token: Option<String>,
    app: AppHandle,
    lan: State<'_, CompanionLan>,
) -> Result<LanInfo, String> {
    lan.start(app, port.unwrap_or(DEFAULT_PORT), token)
}

#[tauri::command]
pub fn companion_lan_stop(lan: State<'_, CompanionLan>) -> LanInfo {
    lan.stop();
    lan.info()
}

#[tauri::command]
pub fn companion_lan_info(lan: State<'_, CompanionLan>) -> LanInfo {
    lan.info()
}

#[tauri::command]
pub fn companion_lan_send(data: String, lan: State<'_, CompanionLan>) -> usize {
    lan.send(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_token_from_query() {
        let req = Request::builder().uri("/?foo=1&token=abc123").body(()).unwrap();
        assert_eq!(token_from_request(&req).as_deref(), Some("abc123"));
        let req = Request::builder().uri("/").body(()).unwrap();
        assert_eq!(token_from_request(&req), None);
    }
}
