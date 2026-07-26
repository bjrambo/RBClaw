import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'vitest';

import { PERSISTENT_SUPERVISOR_MIGRATION } from './021_persistent-supervisor.js';

describe('PERSISTENT_SUPERVISOR_MIGRATION', () => {
  it('backfills episode and total counters without losing legacy state', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE paired_tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE paired_turn_outputs (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          turn_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          output_text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL
        );
        CREATE TABLE work_items (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL
        );
        INSERT INTO paired_tasks VALUES
          ('active-task', 'active', 7, '2026-01-01', '2026-01-02'),
          ('done-task', 'completed', 3, '2026-01-01', '2026-01-03');
      `);

      PERSISTENT_SUPERVISOR_MIGRATION.apply(database);

      expect(
        database
          .prepare(
            `SELECT id, round_trip_count, episode_number,
                    total_round_trip_count, supervisor_state
               FROM paired_tasks ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 'active-task',
          round_trip_count: 7,
          episode_number: 1,
          total_round_trip_count: 7,
          supervisor_state: 'runnable',
        },
        {
          id: 'done-task',
          round_trip_count: 3,
          episode_number: 1,
          total_round_trip_count: 3,
          supervisor_state: 'terminal',
        },
      ]);

      PERSISTENT_SUPERVISOR_MIGRATION.apply(database);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM pragma_table_info('paired_tasks')
              WHERE name = 'supervisor_state'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});
