import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const MESSAGE_METADATA_MIGRATION: SchemaMigrationDefinition = {
  version: 19,
  name: 'message_metadata',
  apply(database: Database) {
    if (!tableHasColumn(database, 'messages', 'message_metadata')) {
      database.exec(`ALTER TABLE messages ADD COLUMN message_metadata TEXT`);
    }
  },
};
