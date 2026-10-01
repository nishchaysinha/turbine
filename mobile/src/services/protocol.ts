/**
 * Turbine ⇄ Companion wire protocol (phone copy; the desktop keeps an
 * identical copy in turbine/src/services/companionProtocol.ts).
 *
 * Follows Orca's remote-wire rules, because the desktop and phone apps update
 * independently and mixed versions are normal:
 *  1. New optional fields on existing messages are safe; readers ignore unknown keys.
 *  2. New behaviour is negotiated: the phone sends `hello` with its
 *     capabilities, the host answers with its own, and either side only uses a
 *     feature both advertised.
 *  3. Unknown message types and unknown enum values degrade, never throw.
 *
 * Envelope: every message is `{ type, payload, timestamp }`. Requests are
 * `type: 'rpc'` with `{ id, method, params }`; replies are `type: 'rpc:result'`
 * with `{ id, ok, result }` or `{ id, ok: false, error: { code, message } }`.
 * A host that predates RPC ignores the request and the client falls back to
 * the legacy fire-and-forget messages.
 */
export const PROTOCOL_VERSION = 2;

export const CAPABILITIES = {
  /** Request/response with ids and structured errors. */
  rpc: 'rpc',
  /** Hook-fed agent status rows (`agents:status` / `agents:clear` events). */
  agents: 'agents',
  /** Host streams terminal output only for panes the client subscribed to. */
  terminalSubscribe: 'terminal.subscribe',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const CLIENT_CAPABILITIES: Capability[] = [CAPABILITIES.rpc, CAPABILITIES.agents, CAPABILITIES.terminalSubscribe];

export type RpcErrorCode = 'unknown_method' | 'bad_params' | 'not_found' | 'failed';

export interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: { code: RpcErrorCode; message: string } };

export class RpcError extends Error {
  constructor(public code: RpcErrorCode, message: string) {
    super(message);
  }
}

export type AgentAction = 'approve' | 'deny' | 'interrupt' | 'prompt';

/** Mirror of the host's agent status row (turbine/src/state/agentStatusStore.ts). */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done';

export interface AgentStatusRow {
  paneId: string;
  state: AgentState | string;
  agent: string;
  prompt: string | null;
  tool: string | null;
  toolInput: string | null;
  message: string | null;
  exitCode: number | null;
  sessionId: string | null;
  startedAt: number;
  updatedAt: number;
  lastEvent: string;
}

/** Unknown states from a newer host degrade to 'waiting' (rule 3). */
export function normalizeAgentState(state: unknown): AgentState {
  return state === 'working' || state === 'blocked' || state === 'done' ? state : 'waiting';
}

