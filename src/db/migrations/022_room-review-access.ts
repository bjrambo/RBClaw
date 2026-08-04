import { getTableColumns } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const ROOM_REVIEW_ACCESS_MIGRATION = {
  version: 22,
  name: 'room_review_access',
  apply(database) {
    if (
      !getTableColumns(database, 'room_settings').includes(
        'review_access_profile',
      )
    ) {
      database.exec(
        'ALTER TABLE room_settings ADD COLUMN review_access_profile TEXT',
      );
    }
  },
} satisfies SchemaMigrationDefinition;
