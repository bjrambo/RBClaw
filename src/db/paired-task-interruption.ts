import type { Database } from 'bun:sqlite';

import { buildPairedTurnIdentity } from '../paired-turn-identity.js';
import {
  getLatestOpenPairedTaskForChatFromDatabase,
  updatePairedTaskIfUnchangedInDatabase,
} from './paired-state-tasks.js';
import {
  cancelPairedTurnInDatabase,
  getPairedTurnsForTaskFromDatabase,
} from './paired-turns.js';

const INTERRUPTION_REASON = 'interrupted_by_user_stop';

/** Stop an execution episode without completing its persistent Goal. */
export function pausePairedTaskForChatInDatabase(
  database: Database,
  chatJid: string,
): boolean {
  return database.transaction(() => {
    const task = getLatestOpenPairedTaskForChatFromDatabase(database, chatJid);
    if (!task) return false;
    const now = new Date(
      Math.max(Date.now(), Date.parse(task.updated_at) + 1),
    ).toISOString();
    const paused = updatePairedTaskIfUnchangedInDatabase(
      database,
      task.id,
      task.updated_at,
      {
        status: 'active',
        supervisor_state: 'waiting_user',
        supervisor_state_changed_at: now,
        last_blocker_class: 'user_input',
        review_phase: 'implementation',
        review_requested_at: null,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        retry_count: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        last_arbiter_directive_json: null,
        last_arbiter_directive_fingerprint: null,
        resume_at: null,
        external_wait_ref: null,
        completion_reason: null,
        updated_at: now,
      },
    );
    if (!paused) return false;

    for (const turn of getPairedTurnsForTaskFromDatabase(database, task.id)) {
      if (!['queued', 'running', 'delegated'].includes(turn.state)) continue;
      cancelPairedTurnInDatabase(database, {
        turnIdentity: buildPairedTurnIdentity({
          taskId: task.id,
          taskUpdatedAt: turn.task_updated_at,
          intentKind: turn.intent_kind,
          role: turn.role,
          turnId: turn.turn_id,
        }),
        error: INTERRUPTION_REASON,
      });
    }

    // Retire pending work atomically with the task revision. Preserve payloads
    // and turn history, but never replay a stopped episode after recovery.
    database
      .prepare(
        `
      UPDATE paired_turn_reservations
         SET status = 'completed', updated_at = ?, consumed_at = ?
       WHERE task_id = ? AND status = 'pending'
    `,
      )
      .run(now, now, task.id);
    database
      .prepare(
        `
      UPDATE service_handoffs
         SET status = 'failed', completed_at = ?, last_error = ?
       WHERE paired_task_id = ? AND status IN ('pending', 'claimed')
    `,
      )
      .run(now, INTERRUPTION_REASON, task.id);
    database
      .prepare(
        `
      UPDATE work_items
         SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = ?
       WHERE paired_task_id = ? AND status IN ('produced', 'delivery_retry')
    `,
      )
      .run(now, now, INTERRUPTION_REASON, task.id);
    database
      .prepare('DELETE FROM paired_task_execution_leases WHERE task_id = ?')
      .run(task.id);
    return true;
  })();
}
