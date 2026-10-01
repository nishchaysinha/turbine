import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 256 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function setCors(res: ServerResponse, methods: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export class BadRequest extends Error {}

/** Reads a JSON body, honouring a body already parsed by the Vercel runtime. */
export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre && typeof pre === 'object') return pre as Record<string, any>;
  if (typeof pre === 'string') return parse(pre);

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('Payload too large');
    chunks.push(buf);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

function parse(text: string): Record<string, any> {
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new BadRequest('Invalid JSON payload');
  }
}
