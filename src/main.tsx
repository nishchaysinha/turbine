import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useSwarmStore } from "./state/swarmStore";
import { useTaskStore } from "./state/taskStore";
import { useAgentStore } from "./state/agentStore";
import { useAgentStatusStore } from "./state/agentStatusStore";
import { p2pBridge } from "./services/p2pBridge";

// Dev-only hooks for the Rust debug bridge (src-tauri/src/debug_bridge.rs):
// eval'd scripts have no module scope, so expose the IPC helpers on window.
if (import.meta.env.DEV) {
  const appWindow = getCurrentWebviewWindow();
  const w = window as Window & {
    __dbgInvoke?: typeof invoke;
    __dbgListen?: typeof listen;
    __dbgWinListen?: typeof appWindow.listen;
  };
  w.__dbgInvoke = invoke;
  w.__dbgListen = listen;
  w.__dbgWinListen = appWindow.listen.bind(appWindow);
  // The app's own store instances: importing modules from an eval'd script can
  // load a second copy after HMR (`?t=` URLs), which the UI never sees.
  (window as Window & { __turbine?: unknown }).__turbine = {
    workspace: useWorkspaceStore,
    swarm: useSwarmStore,
    tasks: useTaskStore,
    agents: useAgentStore,
    agentStatus: useAgentStatusStore,
    bridge: p2pBridge,
  };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
