/**
 * Turbine ⇄ Companion wire protocol (desktop copy; the phone keeps an
 * identical copy in turbine-mobile/src/services/protocol.ts).
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

export const HOST_CAPABILITIES: Capability[] = [CAPABILITIES.rpc, CAPABILITIES.agents, CAPABILITIES.terminalSubscribe];

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
