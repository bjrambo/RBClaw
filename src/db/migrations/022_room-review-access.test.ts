import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'vitest';

import { ROOM_REVIEW_ACCESS_MIGRATION } from './022_room-review-access.js';

describe('ROOM_REVIEW_ACCESS_MIGRATION', () => {
  it('adds the nullable room-scoped profile column idempotently', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE room_settings (
          chat_jid TEXT PRIMARY KEY,
          room_mode TEXT NOT NULL
        )
      `);

      ROOM_REVIEW_ACCESS_MIGRATION.apply(database);
      ROOM_REVIEW_ACCESS_MIGRATION.apply(database);

      expect(
        database
          .prepare(
            `SELECT name, type, "notnull" AS is_not_null
               FROM pragma_table_info('room_settings')
              WHERE name = 'review_access_profile'`,
          )
          .get(),
      ).toEqual({
        name: 'review_access_profile',
        type: 'TEXT',
        is_not_null: 0,
      });
    } finally {
      database.close();
    }
  });
});
