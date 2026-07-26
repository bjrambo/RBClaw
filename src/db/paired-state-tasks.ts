import { Database } from 'bun:sqlite';

import {
  fillCanonicalPairedTaskMetadata,
  readCanonicalPairedTaskMetadata,
} from './canonical-role-metadata.js';
import { PairedTask } from '../types.js';

interface StoredPairedTaskRow extends Omit<
  PairedTask,
  | 'owner_service_id'
  | 'reviewer_service_id'
  | 'owner_agent_type'
  | 'reviewer_agent_type'
  | 'arbiter_agent_type'
> {
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

export type PairedTaskUpdates = Partial<
  Pick<
    PairedTask,
    | 'title'
    | 'source_ref'
    | 'plan_notes'
    | 'review_requested_at'
    | 'round_trip_count'
    | 'episode_number'
    | 'total_round_trip_count'
    | 'arbitration_count'
    | 'stagnation_count'
    | 'progress_fingerprint'
    | 'last_blocker_class'
    | 'resume_at'
    | 'supervisor_state'
    | 'supervisor_state_changed_at'
    | 'last_arbiter_directive_fingerprint'
    | 'last_arbiter_directive_json'
    | 'retry_count'
    | 'external_wait_ref'
    | 'owner_failure_count'
    | 'owner_step_done_streak'
    | 'finalize_step_done_count'
    | 'task_done_then_user_reopen_count'
    | 'empty_step_done_streak'
    | 'status'
    | 'arbiter_verdict'
    | 'arbiter_requested_at'
    | 'completion_reason'
    | 'updated_at'
  >
>;

function hydratePairedTaskRow(
  database: Database,
  row: StoredPairedTaskRow,
): PairedTask {
  const {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType,
    ownerServiceId,
    reviewerServiceId,
  } = readCanonicalPairedTaskMetadata({
    id: row.id,
    owner_service_id: row.owner_service_id,
    reviewer_service_id: row.reviewer_service_id,
    owner_agent_type: row.owner_agent_type,
    reviewer_agent_type: row.reviewer_agent_type,
    arbiter_agent_type: row.arbiter_agent_type,
  });

  return {
    ...row,
    episode_number: row.episode_number ?? 1,
    total_round_trip_count:
      row.total_round_trip_count ?? row.round_trip_count ?? 0,
    arbitration_count: row.arbitration_count ?? 0,
    stagnation_count: row.stagnation_count ?? 0,
    progress_fingerprint: row.progress_fingerprint ?? null,
    last_blocker_class: row.last_blocker_class ?? null,
    resume_at: row.resume_at ?? null,
    supervisor_state:
      row.status === 'completed'
        ? 'terminal'
        : (row.supervisor_state ?? 'runnable'),
    supervisor_state_changed_at:
      row.supervisor_state_changed_at ?? row.updated_at,
    last_arbiter_directive_fingerprint:
      row.last_arbiter_directive_fingerprint ?? null,
    last_arbiter_directive_json: row.last_arbiter_directive_json ?? null,
    retry_count: row.retry_count ?? 0,
    external_wait_ref: row.external_wait_ref ?? null,
    owner_service_id: ownerServiceId,
    reviewer_service_id: reviewerServiceId,
    owner_agent_type: ownerAgentType,
    reviewer_agent_type: reviewerAgentType,
    arbiter_agent_type: arbiterAgentType,
  };
}

export function createPairedTaskInDatabase(
  database: Database,
  task: PairedTask,
): void {
  const {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType,
    ownerServiceId,
    reviewerServiceId,
  } = fillCanonicalPairedTaskMetadata({
    id: task.id,
    owner_service_id: task.owner_service_id,
    reviewer_service_id: task.reviewer_service_id,
    owner_agent_type: task.owner_agent_type,
    reviewer_agent_type: task.reviewer_agent_type,
    arbiter_agent_type: task.arbiter_agent_type,
  });

  database
    .prepare(
      `
        INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          work_dir,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          episode_number,
          total_round_trip_count,
          arbitration_count,
          stagnation_count,
          progress_fingerprint,
          last_blocker_class,
          resume_at,
          supervisor_state,
          supervisor_state_changed_at,
          last_arbiter_directive_fingerprint,
          last_arbiter_directive_json,
          retry_count,
          external_wait_ref,
          owner_failure_count,
          owner_step_done_streak,
          finalize_step_done_count,
          task_done_then_user_reopen_count,
          empty_step_done_streak,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      task.id,
      task.chat_jid,
      task.group_folder,
      task.work_dir,
      ownerServiceId,
      reviewerServiceId,
      ownerAgentType,
      reviewerAgentType,
      arbiterAgentType,
      task.title,
      task.source_ref,
      task.plan_notes,
      task.review_requested_at,
      task.round_trip_count,
      task.episode_number ?? 1,
      task.total_round_trip_count ?? task.round_trip_count,
      task.arbitration_count ?? 0,
      task.stagnation_count ?? 0,
      task.progress_fingerprint ?? null,
      task.last_blocker_class ?? null,
      task.resume_at ?? null,
      task.status === 'completed'
        ? 'terminal'
        : (task.supervisor_state ?? 'runnable'),
      task.supervisor_state_changed_at ?? task.updated_at,
      task.last_arbiter_directive_fingerprint ?? null,
      task.last_arbiter_directive_json ?? null,
      task.retry_count ?? 0,
      task.external_wait_ref ?? null,
      task.owner_failure_count ?? 0,
      task.owner_step_done_streak ?? 0,
      task.finalize_step_done_count ?? 0,
      task.task_done_then_user_reopen_count ?? 0,
      task.empty_step_done_streak ?? 0,
      task.status,
      task.arbiter_verdict,
      task.arbiter_requested_at,
      task.completion_reason,
      task.created_at,
      task.updated_at,
    );
}

export function getPairedTaskByIdFromDatabase(
  database: Database,
  id: string,
): PairedTask | undefined {
  const row = database
    .prepare('SELECT * FROM paired_tasks WHERE id = ?')
    .get(id) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

const latestPairedTaskStmtCache = new WeakMap<
  Database,
  ReturnType<Database['prepare']>
>();

export function getLatestPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
): PairedTask | undefined {
  let stmt = latestPairedTaskStmtCache.get(database);
  if (!stmt) {
    stmt = database.prepare(`
      SELECT *
        FROM paired_tasks
       WHERE chat_jid = ?
       ORDER BY updated_at DESC
       LIMIT 1
    `);
    latestPairedTaskStmtCache.set(database, stmt);
  }
  const row = stmt.get(chatJid) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

export function getLatestOpenPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
): PairedTask | undefined {
  const row = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
           AND status NOT IN ('completed')
         ORDER BY updated_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

export function getAllOpenPairedTasksFromDatabase(
  database: Database,
): PairedTask[] {
  const rows = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE status NOT IN ('completed')
         ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all() as StoredPairedTaskRow[];
  return rows.map((row) => hydratePairedTaskRow(database, row));
}

export function getLatestPreviousPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
  currentTaskId: string,
): PairedTask | undefined {
  const row = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
           AND id != ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid, currentTaskId) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

export function updatePairedTaskInDatabase(
  database: Database,
  id: string,
  updates: PairedTaskUpdates,
): boolean {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.source_ref !== undefined) {
    fields.push('source_ref = ?');
    values.push(updates.source_ref);
  }
  if (updates.plan_notes !== undefined) {
    fields.push('plan_notes = ?');
    values.push(updates.plan_notes);
  }
  if (updates.review_requested_at !== undefined) {
    fields.push('review_requested_at = ?');
    values.push(updates.review_requested_at);
  }
  if (updates.round_trip_count !== undefined) {
    fields.push('round_trip_count = ?');
    values.push(updates.round_trip_count);
  }
  if (updates.episode_number !== undefined) {
    fields.push('episode_number = ?');
    values.push(updates.episode_number);
  }
  if (updates.total_round_trip_count !== undefined) {
    fields.push('total_round_trip_count = ?');
    values.push(updates.total_round_trip_count);
  }
  if (updates.arbitration_count !== undefined) {
    fields.push('arbitration_count = ?');
    values.push(updates.arbitration_count);
  }
  if (updates.stagnation_count !== undefined) {
    fields.push('stagnation_count = ?');
    values.push(updates.stagnation_count);
  }
  if (updates.progress_fingerprint !== undefined) {
    fields.push('progress_fingerprint = ?');
    values.push(updates.progress_fingerprint);
  }
  if (updates.last_blocker_class !== undefined) {
    fields.push('last_blocker_class = ?');
    values.push(updates.last_blocker_class);
  }
  if (updates.resume_at !== undefined) {
    fields.push('resume_at = ?');
    values.push(updates.resume_at);
  }
  if (updates.supervisor_state !== undefined) {
    fields.push('supervisor_state = ?');
    values.push(updates.supervisor_state);
  }
  if (updates.supervisor_state_changed_at !== undefined) {
    fields.push('supervisor_state_changed_at = ?');
    values.push(updates.supervisor_state_changed_at);
  }
  if (updates.last_arbiter_directive_fingerprint !== undefined) {
    fields.push('last_arbiter_directive_fingerprint = ?');
    values.push(updates.last_arbiter_directive_fingerprint);
  }
  if (updates.last_arbiter_directive_json !== undefined) {
    fields.push('last_arbiter_directive_json = ?');
    values.push(updates.last_arbiter_directive_json);
  }
  if (updates.retry_count !== undefined) {
    fields.push('retry_count = ?');
    values.push(updates.retry_count);
  }
  if (updates.external_wait_ref !== undefined) {
    fields.push('external_wait_ref = ?');
    values.push(updates.external_wait_ref);
  }
  if (updates.owner_failure_count !== undefined) {
    fields.push('owner_failure_count = ?');
    values.push(updates.owner_failure_count);
  }
  if (updates.owner_step_done_streak !== undefined) {
    fields.push('owner_step_done_streak = ?');
    values.push(updates.owner_step_done_streak);
  }
  if (updates.finalize_step_done_count !== undefined) {
    fields.push('finalize_step_done_count = ?');
    values.push(updates.finalize_step_done_count);
  }
  if (updates.task_done_then_user_reopen_count !== undefined) {
    fields.push('task_done_then_user_reopen_count = ?');
    values.push(updates.task_done_then_user_reopen_count);
  }
  if (updates.empty_step_done_streak !== undefined) {
    fields.push('empty_step_done_streak = ?');
    values.push(updates.empty_step_done_streak);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.arbiter_verdict !== undefined) {
    fields.push('arbiter_verdict = ?');
    values.push(updates.arbiter_verdict);
  }
  if (updates.arbiter_requested_at !== undefined) {
    fields.push('arbiter_requested_at = ?');
    values.push(updates.arbiter_requested_at);
  }
  if (updates.completion_reason !== undefined) {
    fields.push('completion_reason = ?');
    values.push(updates.completion_reason);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return false;

  values.push(id);
  const result = database
    .prepare(`UPDATE paired_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function updatePairedTaskIfUnchangedInDatabase(
  database: Database,
  id: string,
  expectedUpdatedAt: string,
  updates: PairedTaskUpdates,
): boolean {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.source_ref !== undefined) {
    fields.push('source_ref = ?');
    values.push(updates.source_ref);
  }
  if (updates.plan_notes !== undefined) {
    fields.push('plan_notes = ?');
    values.push(updates.plan_notes);
  }
  if (updates.review_requested_at !== undefined) {
    fields.push('review_requested_at = ?');
    values.push(updates.review_requested_at);
  }
  if (updates.round_trip_count !== undefined) {
    fields.push('round_trip_count = ?');
    values.push(updates.round_trip_count);
  }
  if (updates.episode_number !== undefined) {
    fields.push('episode_number = ?');
    values.push(updates.episode_number);
  }
  if (updates.total_round_trip_count !== undefined) {
    fields.push('total_round_trip_count = ?');
    values.push(updates.total_round_trip_count);
  }
  if (updates.arbitration_count !== undefined) {
    fields.push('arbitration_count = ?');
    values.push(updates.arbitration_count);
  }
  if (updates.stagnation_count !== undefined) {
    fields.push('stagnation_count = ?');
    values.push(updates.stagnation_count);
  }
  if (updates.progress_fingerprint !== undefined) {
    fields.push('progress_fingerprint = ?');
    values.push(updates.progress_fingerprint);
  }
  if (updates.last_blocker_class !== undefined) {
    fields.push('last_blocker_class = ?');
    values.push(updates.last_blocker_class);
  }
  if (updates.resume_at !== undefined) {
    fields.push('resume_at = ?');
    values.push(updates.resume_at);
  }
  if (updates.supervisor_state !== undefined) {
    fields.push('supervisor_state = ?');
    values.push(updates.supervisor_state);
  }
  if (updates.supervisor_state_changed_at !== undefined) {
    fields.push('supervisor_state_changed_at = ?');
    values.push(updates.supervisor_state_changed_at);
  }
  if (updates.last_arbiter_directive_fingerprint !== undefined) {
    fields.push('last_arbiter_directive_fingerprint = ?');
    values.push(updates.last_arbiter_directive_fingerprint);
  }
  if (updates.last_arbiter_directive_json !== undefined) {
    fields.push('last_arbiter_directive_json = ?');
    values.push(updates.last_arbiter_directive_json);
  }
  if (updates.retry_count !== undefined) {
    fields.push('retry_count = ?');
    values.push(updates.retry_count);
  }
  if (updates.external_wait_ref !== undefined) {
    fields.push('external_wait_ref = ?');
    values.push(updates.external_wait_ref);
  }
  if (updates.owner_failure_count !== undefined) {
    fields.push('owner_failure_count = ?');
    values.push(updates.owner_failure_count);
  }
  if (updates.owner_step_done_streak !== undefined) {
    fields.push('owner_step_done_streak = ?');
    values.push(updates.owner_step_done_streak);
  }
  if (updates.finalize_step_done_count !== undefined) {
    fields.push('finalize_step_done_count = ?');
    values.push(updates.finalize_step_done_count);
  }
  if (updates.task_done_then_user_reopen_count !== undefined) {
    fields.push('task_done_then_user_reopen_count = ?');
    values.push(updates.task_done_then_user_reopen_count);
  }
  if (updates.empty_step_done_streak !== undefined) {
    fields.push('empty_step_done_streak = ?');
    values.push(updates.empty_step_done_streak);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.arbiter_verdict !== undefined) {
    fields.push('arbiter_verdict = ?');
    values.push(updates.arbiter_verdict);
  }
  if (updates.arbiter_requested_at !== undefined) {
    fields.push('arbiter_requested_at = ?');
    values.push(updates.arbiter_requested_at);
  }
  if (updates.completion_reason !== undefined) {
    fields.push('completion_reason = ?');
    values.push(updates.completion_reason);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return false;

  values.push(id, expectedUpdatedAt);
  const result = database
    .prepare(
      `UPDATE paired_tasks SET ${fields.join(', ')} WHERE id = ? AND updated_at = ?`,
    )
    .run(...values);
  return result.changes > 0;
}
