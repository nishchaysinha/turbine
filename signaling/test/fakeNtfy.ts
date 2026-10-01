import { vi } from 'vitest';

interface Msg {
  time: number;
  message: string;
}

/** Minimal in-memory stand-in for ntfy.sh publish + `/json?poll=1&since=` endpoints. */
export function installFakeNtfy() {
  const topics = new Map<string, Msg[]>();
  let clock = Math.floor(Date.now() / 1000);

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/+/, '');
    if ((init?.method || 'GET') === 'POST') {
      const list = topics.get(path) || [];
      list.push({ time: clock, message: String(init?.body ?? '') });
      topics.set(path, list);
      return new Response('{}', { status: 200 });
    }
    const topic = path.replace(/\/json$/, '');
    const since = Number(url.searchParams.get('since') || 0);
    const lines = (topics.get(topic) || [])
      .filter((m) => m.time >= since)
      .map((m) => JSON.stringify({ event: 'message', time: m.time, message: m.message }));
    return new Response(lines.join('\n'), { status: 200 });
  });

  vi.stubGlobal('fetch', fetchMock);
  return {
    topics,
    fetchMock,
    tick(sec = 1) {
      clock += sec;
    },
  };
}
