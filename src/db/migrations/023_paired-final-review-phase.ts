import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const PAIRED_FINAL_REVIEW_PHASE_MIGRATION: SchemaMigrationDefinition = {
  version: 23,
  name: 'paired_final_review_phase',
  apply(database: Database) {
    if (!tableHasColumn(database, 'paired_tasks', 'review_phase')) {
      database.exec(`
        ALTER TABLE paired_tasks
        ADD COLUMN review_phase TEXT NOT NULL DEFAULT 'implementation'
          CHECK (review_phase IN ('implementation', 'final'))
      `);
    }

    database.exec(`
      UPDATE paired_tasks
         SET review_phase = 'implementation'
       WHERE review_phase IS NULL
          OR review_phase NOT IN ('implementation', 'final')
    `);
  },
};
