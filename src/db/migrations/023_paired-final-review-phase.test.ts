import { Database } from 'bun:sqlite';

import { describe, expect, it } from 'vitest';

import { PAIRED_FINAL_REVIEW_PHASE_MIGRATION } from './023_paired-final-review-phase.js';

describe('paired final review phase migration', () => {
  it('adds an idempotent implementation review phase to existing tasks', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE paired_tasks (
          id TEXT PRIMARY KEY
        );
        INSERT INTO paired_tasks (id) VALUES ('task-1');
      `);

      PAIRED_FINAL_REVIEW_PHASE_MIGRATION.apply(database, {
        assistantName: 'zinna',
      });
      PAIRED_FINAL_REVIEW_PHASE_MIGRATION.apply(database, {
        assistantName: 'zinna',
      });

      const columns = database
        .prepare('PRAGMA table_info(paired_tasks)')
        .all() as Array<{ name: string }>;
      const row = database
        .prepare('SELECT review_phase FROM paired_tasks WHERE id = ?')
        .get('task-1') as { review_phase: string };

      expect(columns.map((column) => column.name)).toContain('review_phase');
      expect(row.review_phase).toBe('implementation');
    } finally {
      database.close();
    }
  });
});
