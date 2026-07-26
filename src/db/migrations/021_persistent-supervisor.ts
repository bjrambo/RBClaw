import { getTableColumns } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

function addColumn(
  database: Parameters<SchemaMigrationDefinition['apply']>[0],
  table: string,
  definition: string,
): void {
  const name = definition.trim().split(/\s+/, 1)[0];
  if (!getTableColumns(database, table).includes(name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export const PERSISTENT_SUPERVISOR_MIGRATION = {
  version: 21,
  name: 'persistent_supervisor',
  apply(database) {
    const migrate = database.transaction(() => {
      addColumn(
        database,
        'paired_tasks',
        `episode_number INTEGER NOT NULL DEFAULT 1`,
      );
      addColumn(
        database,
        'paired_tasks',
        `total_round_trip_count INTEGER NOT NULL DEFAULT 0`,
      );
      addColumn(
        database,
        'paired_tasks',
        `arbitration_count INTEGER NOT NULL DEFAULT 0`,
      );
      addColumn(
        database,
        'paired_tasks',
        `stagnation_count INTEGER NOT NULL DEFAULT 0`,
      );
      addColumn(database, 'paired_tasks', `progress_fingerprint TEXT`);
      addColumn(database, 'paired_tasks', `last_blocker_class TEXT`);
      addColumn(database, 'paired_tasks', `resume_at TEXT`);
      addColumn(
        database,
        'paired_tasks',
        `supervisor_state TEXT NOT NULL DEFAULT 'runnable'`,
      );
      addColumn(database, 'paired_tasks', `supervisor_state_changed_at TEXT`);
      addColumn(
        database,
        'paired_tasks',
        `last_arbiter_directive_fingerprint TEXT`,
      );
      addColumn(database, 'paired_tasks', `last_arbiter_directive_json TEXT`);
      addColumn(
        database,
        'paired_tasks',
        `retry_count INTEGER NOT NULL DEFAULT 0`,
      );
      addColumn(database, 'paired_tasks', `external_wait_ref TEXT`);

      addColumn(database, 'scheduled_tasks', `paired_task_id TEXT`);
      addColumn(database, 'scheduled_tasks', `external_wait_ref TEXT`);
      addColumn(database, 'scheduled_tasks', `watcher_dedup_key TEXT`);
      addColumn(database, 'scheduled_tasks', `terminal_event_applied_at TEXT`);

      addColumn(database, 'paired_turn_outputs', `arbiter_directive_json TEXT`);
      addColumn(
        database,
        'paired_turn_outputs',
        `arbiter_directive_fingerprint TEXT`,
      );

      addColumn(database, 'work_items', `delivery_key TEXT`);
      addColumn(database, 'work_items', `paired_task_id TEXT`);
      addColumn(database, 'work_items', `delivery_receipts TEXT`);
      addColumn(
        database,
        'work_items',
        `delivery_uncertain INTEGER NOT NULL DEFAULT 0`,
      );
      addColumn(database, 'work_items', `delivery_claimed_at TEXT`);

      database.exec(`
        UPDATE paired_tasks
           SET total_round_trip_count = round_trip_count
         WHERE total_round_trip_count = 0 AND round_trip_count > 0;

        UPDATE paired_tasks
           SET supervisor_state =
             CASE WHEN status = 'completed' THEN 'terminal' ELSE 'runnable' END,
               supervisor_state_changed_at =
             COALESCE(supervisor_state_changed_at, updated_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_goal_external_wait
          ON scheduled_tasks(paired_task_id, external_wait_ref)
          WHERE paired_task_id IS NOT NULL
            AND external_wait_ref IS NOT NULL
            AND status IN ('active', 'paused');

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_delivery_key
          ON work_items(delivery_key)
          WHERE delivery_key IS NOT NULL;
      `);
    });
    migrate();
  },
} satisfies SchemaMigrationDefinition;
