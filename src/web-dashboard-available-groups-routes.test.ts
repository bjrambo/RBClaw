import { describe, expect, it, vi } from 'vitest';

import { handleAvailableGroupsRoute } from './web-dashboard-available-groups-routes.js';

const listAvailableGroups = vi.hoisted(() => vi.fn());

vi.mock('./available-groups.js', () => ({
  listAvailableGroups,
}));

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

describe('web dashboard available groups route', () => {
  it('serves all available groups with folder metadata', async () => {
    listAvailableGroups.mockReturnValue([
      {
        jid: 'dc:ops',
        name: '#ops',
        lastActivity: '2026-07-03T12:00:00.000Z',
        isRegistered: true,
        folder: 'ops-room',
      },
      {
        jid: 'dc:quiet',
        name: '#quiet',
        lastActivity: '2026-07-01T12:00:00.000Z',
        isRegistered: false,
        folder: null,
      },
    ]);
    const bindings = {
      'dc:ops': {
        name: '#ops',
        folder: 'ops-room',
        added_at: '2026-07-03T00:00:00.000Z',
      },
    };

    const response = handleAvailableGroupsRoute({
      url: new URL('http://localhost/api/available-groups'),
      request: new Request('http://localhost/api/available-groups'),
      jsonResponse,
      authToken: 'test-secret',
      loadRoomBindings: () => bindings,
      now: () => '2026-07-03T12:34:56.000Z',
    });

    expect(response?.status).toBe(401);
    const authorized = handleAvailableGroupsRoute({
      url: new URL('http://localhost/api/available-groups'),
      request: new Request('http://localhost/api/available-groups', {
        headers: { 'x-rbclaw-dashboard-token': 'test-secret' },
      }),
      jsonResponse,
      authToken: 'test-secret',
      loadRoomBindings: () => bindings,
      now: () => '2026-07-03T12:34:56.000Z',
    });

    expect(authorized?.status).toBe(200);
    expect(listAvailableGroups).toHaveBeenCalledWith(bindings);
    await expect(authorized?.json()).resolves.toEqual({
      groups: [
        {
          jid: 'dc:ops',
          name: '#ops',
          lastActivity: '2026-07-03T12:00:00.000Z',
          isRegistered: true,
          folder: 'ops-room',
        },
        {
          jid: 'dc:quiet',
          name: '#quiet',
          lastActivity: '2026-07-01T12:00:00.000Z',
          isRegistered: false,
          folder: null,
        },
      ],
      lastSync: '2026-07-03T12:34:56.000Z',
    });
  });

  it('falls through outside available groups routes', () => {
    expect(
      handleAvailableGroupsRoute({
        url: new URL('http://localhost/api/health'),
        request: new Request('http://localhost/api/health'),
        jsonResponse,
      }),
    ).toBeNull();
  });
});
