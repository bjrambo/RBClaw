import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readDashboardToken,
  sendRoomMessage,
  writeDashboardToken,
} from './api';

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

describe('dashboard API token storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stores a trimmed dashboard token in browser storage', () => {
    installLocalStorage();

    writeDashboardToken('  token-123  ');

    expect(readDashboardToken()).toBe('token-123');
  });

  it('attaches the dashboard token to mutating requests', async () => {
    installLocalStorage();
    writeDashboardToken('token-123');
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({ ok: true, id: 'msg-1', queued: true }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendRoomMessage('dc:room', 'hello', 'req-1', 'Dashboard');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit?,
    ];
    expect(
      (init?.headers as Record<string, string>)['x-rbclaw-dashboard-token'],
    ).toBe('token-123');
  });
});
