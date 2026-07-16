import { Database } from 'bun:sqlite';

import { describe, expect, it } from 'vitest';

import { DIRECT_ROOM_WORKDIR_MIGRATION } from './020_direct-room-workdir.js';

function tableExists(database: Database, tableName: string): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName),
  );
}

describe('DIRECT_ROOM_WORKDIR_MIGRATION', () => {
  it('backfills task work directories before removing workspace tables', () => {
    const database = new Database(':memory:');

    try {
      database.exec(`
        CREATE TABLE paired_tasks (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL
        );
        CREATE TABLE paired_projects (
          chat_jid TEXT PRIMARY KEY,
          canonical_work_dir TEXT
        );
        CREATE TABLE paired_workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE room_settings (
          chat_jid TEXT PRIMARY KEY,
          work_dir TEXT
        );

        INSERT INTO paired_tasks (id, chat_jid) VALUES
          ('project-task', 'project-room'),
          ('room-task', 'room-only');
        INSERT INTO paired_projects (chat_jid, canonical_work_dir)
          VALUES ('project-room', '/srv/project');
        INSERT INTO room_settings (chat_jid, work_dir) VALUES
          ('project-room', '/srv/room-fallback'),
          ('room-only', '/srv/room-only');
      `);

      DIRECT_ROOM_WORKDIR_MIGRATION.apply(database);

      expect(
        database
          .prepare(`SELECT id, work_dir FROM paired_tasks ORDER BY id ASC`)
          .all(),
      ).toEqual([
        { id: 'project-task', work_dir: '/srv/project' },
        { id: 'room-task', work_dir: '/srv/room-only' },
      ]);
      expect(tableExists(database, 'paired_projects')).toBe(false);
      expect(tableExists(database, 'paired_workspaces')).toBe(false);

      expect(() =>
        database
          .prepare(
            `INSERT INTO paired_tasks (id, chat_jid, work_dir)
             VALUES (?, ?, ?)`,
          )
          .run('blank-task', 'blank-room', '  '),
      ).toThrow(/work_dir is required/);
      expect(() =>
        database
          .prepare(`UPDATE paired_tasks SET work_dir = NULL WHERE id = ?`)
          .run('project-task'),
      ).toThrow(/work_dir is required/);
    } finally {
      database.close();
    }
  });

  it('rolls back without dropping tables when any task has no work directory', () => {
    const database = new Database(':memory:');

    try {
      database.exec(`
        CREATE TABLE paired_tasks (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL
        );
        CREATE TABLE paired_projects (
          chat_jid TEXT PRIMARY KEY,
          canonical_work_dir TEXT
        );
        CREATE TABLE paired_workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE room_settings (
          chat_jid TEXT PRIMARY KEY,
          work_dir TEXT
        );
        INSERT INTO paired_tasks (id, chat_jid)
          VALUES ('missing-task', 'missing-room');
      `);

      expect(() => DIRECT_ROOM_WORKDIR_MIGRATION.apply(database)).toThrow(
        /1 paired task\(s\) have no work_dir/,
      );

      const columns = database
        .prepare(`PRAGMA table_info(paired_tasks)`)
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('work_dir');
      expect(tableExists(database, 'paired_projects')).toBe(true);
      expect(tableExists(database, 'paired_workspaces')).toBe(true);
    } finally {
      database.close();
    }
  });
});
