import { getTableColumns } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

function tableExists(
  database: Parameters<SchemaMigrationDefinition['apply']>[0],
  tableName: string,
): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName),
  );
}

export const DIRECT_ROOM_WORKDIR_MIGRATION = {
  version: 20,
  name: 'direct_room_workdir',
  apply(database) {
    const migrate = database.transaction(() => {
      if (!getTableColumns(database, 'paired_tasks').includes('work_dir')) {
        database.exec(`ALTER TABLE paired_tasks ADD COLUMN work_dir TEXT`);
      }

      if (tableExists(database, 'paired_projects')) {
        database.exec(`
          UPDATE paired_tasks
             SET work_dir = (
               SELECT canonical_work_dir
                 FROM paired_projects
                WHERE paired_projects.chat_jid = paired_tasks.chat_jid
             )
           WHERE work_dir IS NULL OR trim(work_dir) = ''
        `);
      }

      if (tableExists(database, 'room_settings')) {
        database.exec(`
          UPDATE paired_tasks
             SET work_dir = (
               SELECT work_dir
                 FROM room_settings
                WHERE room_settings.chat_jid = paired_tasks.chat_jid
             )
           WHERE work_dir IS NULL OR trim(work_dir) = ''
        `);
      }

      const missing = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM paired_tasks
            WHERE work_dir IS NULL OR trim(work_dir) = ''`,
        )
        .get() as { count: number };
      if (missing.count > 0) {
        throw new Error(
          `Cannot remove legacy paired tables: ${missing.count} paired task(s) have no work_dir.`,
        );
      }

      database.exec(`
        CREATE TRIGGER IF NOT EXISTS paired_tasks_require_work_dir_insert
        BEFORE INSERT ON paired_tasks
        WHEN NEW.work_dir IS NULL OR trim(NEW.work_dir) = ''
        BEGIN
          SELECT RAISE(ABORT, 'paired_tasks.work_dir is required');
        END;

        CREATE TRIGGER IF NOT EXISTS paired_tasks_require_work_dir_update
        BEFORE UPDATE OF work_dir ON paired_tasks
        WHEN NEW.work_dir IS NULL OR trim(NEW.work_dir) = ''
        BEGIN
          SELECT RAISE(ABORT, 'paired_tasks.work_dir is required');
        END;

        DROP TABLE IF EXISTS paired_workspaces;
        DROP TABLE IF EXISTS paired_projects;
      `);
    });

    migrate();
  },
} satisfies SchemaMigrationDefinition;
