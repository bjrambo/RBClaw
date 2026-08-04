import { Database } from 'bun:sqlite';

import { describe, expect, it, vi } from 'vitest';

import {
  remoteReviewTestHelpers,
  runRemoteReviewInspection,
} from './remote-review-evidence.js';

function createRoomDatabase(profile: string | null): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE room_settings (
      chat_jid TEXT PRIMARY KEY,
      folder TEXT,
      review_access_profile TEXT
    );
    CREATE TABLE paired_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  database
    .prepare(
      'INSERT INTO room_settings (chat_jid, folder, review_access_profile) VALUES (?, ?, ?)',
    )
    .run('dc:test-room', 'room-folder', profile);
  database
    .prepare(
      'INSERT INTO paired_tasks (id, chat_jid, group_folder, status) VALUES (?, ?, ?, ?)',
    )
    .run('task-1', 'dc:test-room', 'room-folder', 'in_review');
  return database;
}

describe('remote review evidence', () => {
  it('allows only the reviewer in a room with a configured profile', async () => {
    const database = createRoomDatabase('web-review');
    const inspectWeb = vi.fn(async () => ({ checks: [{ status: 200 }] }));
    const loadProfile = vi.fn(() => ({
      environments: {
        production: {
          web: {
            baseUrl: 'https://example.com',
            paths: ['/'],
            allowedOrigins: [],
            allowedPrivateCidrs: [],
          },
        },
      },
    }));

    const output = await runRemoteReviewInspection(
      {
        sourceGroup: 'room-folder',
        roomRole: 'reviewer',
        pairedTaskId: 'task-1',
        environment: 'production',
        check: 'inspect_web',
      },
      { database, inspectWeb, loadProfile },
    );
    expect(JSON.parse(output)).toMatchObject({
      room: 'dc:test-room',
      profile: 'web-review',
      pairedTaskId: 'task-1',
      result: { checks: [{ status: 200 }] },
    });

    await expect(
      runRemoteReviewInspection(
        {
          sourceGroup: 'room-folder',
          roomRole: 'owner',
          pairedTaskId: 'task-1',
          environment: 'production',
          check: 'inspect_web',
        },
        { database, inspectWeb, loadProfile },
      ),
    ).rejects.toThrow('restricted to the reviewer role');
  });

  it('fails closed when the room has no review profile', async () => {
    const database = createRoomDatabase(null);
    await expect(
      runRemoteReviewInspection(
        {
          sourceGroup: 'room-folder',
          roomRole: 'reviewer',
          pairedTaskId: 'task-1',
          environment: 'production',
          check: 'inspect_web',
        },
        { database },
      ),
    ).rejects.toThrow('not enabled for this room');
  });

  it('rejects stale or mismatched reviewer task ids', async () => {
    const database = createRoomDatabase('web-review');
    await expect(
      runRemoteReviewInspection(
        {
          sourceGroup: 'room-folder',
          roomRole: 'reviewer',
          pairedTaskId: 'stale-task',
          environment: 'production',
          check: 'inspect_web',
        },
        { database },
      ),
    ).rejects.toThrow('no active reviewer turn');
  });

  it('returns config structure without returning values', () => {
    const content = JSON.stringify({
      database: { host: 'secret-host', password: 'secret-password' },
      featureFlags: { beta: true },
    });
    const keys = remoteReviewTestHelpers.extractConfigStructure(content);
    expect(keys).toEqual([
      'database',
      'database.host',
      'database.password',
      'featureFlags',
      'featureFlags.beta',
    ]);
    expect(JSON.stringify(keys)).not.toContain('secret-host');
    expect(JSON.stringify(keys)).not.toContain('secret-password');
  });

  it('redacts common PII and credential forms from logs', () => {
    const redacted = remoteReviewTestHelpers.redactDiagnosticText(
      'user@example.com 203.0.113.9 token=abc Authorization: BearerSecret',
    );
    expect(redacted).not.toContain('user@example.com');
    expect(redacted).not.toContain('203.0.113.9');
    expect(redacted).not.toContain('BearerSecret');
  });

  it('checks resolved remote paths case-insensitively for secrets', () => {
    const script = remoteReviewTestHelpers.buildResolvedFileReadScript(
      { id: 'nginx-main', path: '/etc/nginx/nginx.conf' },
      {
        sshProfile: 'egot',
        allowedRoots: ['/etc/nginx'],
        serviceUnits: [],
        journalUnits: [],
        logFiles: [],
        configFiles: [],
      },
      'file',
    );
    expect(script).toContain("tr '[:upper:]' '[:lower:]'");
    expect(script).toContain('case "$lower" in');
  });
});
