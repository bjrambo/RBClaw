import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebDashboardHandler } from './web-dashboard-server.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('web dashboard API auth', () => {
  it('keeps regular API routes readable when dashboard auth is configured', async () => {
    const handler = createWebDashboardHandler({
      authToken: 'mobile-secret',
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      startBackgroundCacheRefresh: false,
    });

    const missing = await handler(new Request('http://localhost/api/health'));
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({ ok: true });

    const wrong = await handler(
      new Request('http://localhost/api/health', {
        headers: { authorization: 'Bearer wrong-secret' },
      }),
    );
    expect(wrong.status).toBe(200);
    await expect(wrong.json()).resolves.toEqual({ ok: true });

    const ok = await handler(
      new Request('http://localhost/api/health', {
        headers: { authorization: 'Bearer mobile-secret' },
      }),
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ ok: true });
  });

  it('accepts the mobile token header and leaves static assets readable', async () => {
    const staticDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rbclaw-dashboard-auth-'),
    );
    tempDirs.push(staticDir);
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<main>ok</main>');
    const handler = createWebDashboardHandler({
      authToken: 'mobile-secret',
      staticDir,
      readStatusSnapshots: () => [],
      getTasks: () => [],
      startBackgroundCacheRefresh: false,
    });

    const asset = await handler(new Request('http://localhost/'));
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain('<main>ok</main>');

    const api = await handler(
      new Request('http://localhost/api/health', {
        headers: { 'x-rbclaw-dashboard-token': 'mobile-secret' },
      }),
    );
    expect(api.status).toBe(200);
  });

  it('requires the configured token for dashboard room message injection', async () => {
    const handler = createWebDashboardHandler({
      authToken: 'mobile-secret',
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getRoomBindings: () => ({
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      }),
      storeChatMetadata: () => {},
      storeMessage: () => {},
      hasMessage: () => false,
      publishRoomMessage: async () => {},
      enqueueMessageCheck: () => {},
      startBackgroundCacheRefresh: false,
    });

    const url = `http://localhost/api/rooms/${encodeURIComponent(
      'dc:ops',
    )}/messages`;
    const body = JSON.stringify({ text: 'deploy' });

    const missing = await handler(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const wrong = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rbclaw-dashboard-token': 'wrong-secret',
        },
        body,
      }),
    );
    expect(wrong.status).toBe(401);

    const ok = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rbclaw-dashboard-token': 'mobile-secret',
        },
        body,
      }),
    );
    expect(ok.status).toBe(200);
  });

  it('requires the configured token for mutating API routes', async () => {
    const handler = createWebDashboardHandler({
      authToken: 'mobile-secret',
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      startBackgroundCacheRefresh: false,
    });

    const settings = await handler(
      new Request('http://localhost/api/settings/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: { model: 'gpt-5' } }),
      }),
    );
    expect(settings.status).toBe(401);
    expect(settings.headers.get('www-authenticate')).toBe('Bearer');

    const task = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'run anything' }),
      }),
    );
    expect(task.status).toBe(401);
    expect(task.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('requires a configured token for dashboard room message injection', async () => {
    const handler = createWebDashboardHandler({
      authToken: '',
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getRoomBindings: () => ({
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      }),
      storeChatMetadata: () => {},
      storeMessage: () => {},
      hasMessage: () => false,
      enqueueMessageCheck: () => {},
      startBackgroundCacheRefresh: false,
    });

    const health = await handler(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);

    const message = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'deploy' }),
        },
      ),
    );
    expect(message.status).toBe(503);
    await expect(message.json()).resolves.toMatchObject({
      error: expect.stringContaining('WEB_DASHBOARD_TOKEN'),
    });
  });
});
