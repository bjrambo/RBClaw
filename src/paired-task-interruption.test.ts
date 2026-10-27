import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  claimPairedTurnReservation,
  createPairedTask,
  createProducedWorkItem,
  createServiceHandoff,
  getLatestOpenPairedTaskForChat,
  getPairedTaskById,
  getPairedTurnAttempts,
  getPairedTurnsForTask,
  getPairedTurnOutputs,
  getPendingServiceHandoffs,
  getWorkItemById,
  insertPairedTurnOutput,
  pausePairedTaskForChat,
  reservePairedTurnReservation,
} from './db.js';
import { requireDatabase } from './db/runtime-database.js';
import {
  completePairedExecutionContext,
  preparePairedExecutionContext,
  resolveOwnerTaskForHumanMessage,
} from './paired-execution-context.js';
import { createPairedExecutionLifecycle } from './message-agent-executor-paired.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import {
  requeueRecoverablePendingPairedFollowUps,
  schedulePairedFollowUpOnce,
} from './paired-follow-up-scheduler.js';
import type { PairedTask, RegisteredGroup } from './types.js';

const room = 'dc:stop-continuity';
const group: RegisteredGroup = {
  name: 'Stop continuity',
  folder: 'stop-continuity',
  trigger: '@bot',
  added_at: '2026-10-01T00:00:00.000Z',
  workDir: process.cwd(),
};
const ownerContext = {
  serviceId: 'codex-main',
  role: 'owner' as const,
  ownerServiceId: 'codex-main',
  reviewerServiceId: 'claude',
  failoverOwner: false,
};
function task(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'same-goal',
    chat_jid: room,
    group_folder: group.folder,
    work_dir: process.cwd(),
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    title: 'Original goal',
    source_ref: 'HEAD',
    plan_notes: 'Preserve original constraints',
    review_requested_at: null,
    round_trip_count: 2,
    total_round_trip_count: 12,
    arbitration_count: 3,
    episode_number: 4,
    status: 'active',
    supervisor_state: 'runnable',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:01:00.000Z',
    ...overrides,
  };
}
beforeEach(() => {
  _initTestDatabase();
});

describe('user stop preserves the persistent Goal', () => {
  it.each([
    'active',
    'review_ready',
    'in_review',
    'merge_ready',
    'arbiter_requested',
    'in_arbitration',
  ] as const)(
    'pauses %s and resumes the same Goal from owner implementation',
    (status) => {
      const original = task({
        status,
        review_phase: 'final',
        arbiter_verdict: 'proceed',
      });
      createPairedTask(original);
      insertPairedTurnOutput(
        original.id,
        1,
        'reviewer',
        'STEP_DONE\nOWNER_ACTION: file-edit',
      );
      expect(pausePairedTaskForChat(room)).toBe(true);
      const paused = getLatestOpenPairedTaskForChat(room)!;
      expect(paused).toMatchObject({
        id: original.id,
        status: 'active',
        supervisor_state: 'waiting_user',
        review_phase: 'implementation',
        completion_reason: null,
        last_blocker_class: 'user_input',
        arbiter_verdict: null,
        title: original.title,
        plan_notes: original.plan_notes,
        total_round_trip_count: 12,
        arbitration_count: 3,
      });
      const enqueue = vi.fn();
      expect(
        schedulePairedFollowUpOnce({
          chatJid: room,
          runId: 'must-not-run',
          task: paused,
          intentKind: 'owner-follow-up',
          enqueue,
        }),
      ).toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
      const resumed = resolveOwnerTaskForHumanMessage({
        group,
        chatJid: room,
      }).task!;
      expect(resumed).toMatchObject({
        id: original.id,
        status: 'active',
        supervisor_state: 'runnable',
        episode_number: 5,
        total_round_trip_count: 12,
        arbitration_count: 3,
      });
      const prepared = preparePairedExecutionContext({
        group,
        chatJid: room,
        runId: 'direction-b',
        roomRoleContext: ownerContext,
        hasHumanMessage: true,
      });
      expect(prepared?.task.id).toBe(original.id);
      expect(prepared?.ownerRequiredAction).toBe('unspecified');
      expect(getPairedTurnOutputs(original.id)).toHaveLength(1);
    },
  );

  it('atomically retires old turns, reservations, handoffs, delivery retries and execution leases', () => {
    const original = task();
    createPairedTask(original);
    const args = {
      chatJid: room,
      taskId: original.id,
      taskStatus: original.status,
      roundTripCount: original.round_trip_count,
      taskUpdatedAt: original.updated_at,
      intentKind: 'owner-turn' as const,
      runId: 'stopped-run',
    };
    expect(claimPairedTurnReservation(args)).toBe(true);
    expect(
      reservePairedTurnReservation({ ...args, intentKind: 'owner-follow-up' }),
    ).toBe(true);
    const handoff = createServiceHandoff({
      chat_jid: room,
      group_folder: group.folder,
      paired_task_id: original.id,
      paired_task_updated_at: original.updated_at,
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: 'codex-main',
      target_service_id: 'claude',
      source_role: 'owner',
      target_role: 'reviewer',
      target_agent_type: 'claude-code',
      prompt: 'Old review',
    });
    const work = createProducedWorkItem({
      group_folder: group.folder,
      chat_jid: room,
      paired_task_id: original.id,
      agent_type: 'codex',
      delivery_role: 'owner',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'Old final',
    });
    expect(pausePairedTaskForChat(room)).toBe(true);
    expect(
      getPairedTurnsForTask(original.id).every((t) => t.state === 'cancelled'),
    ).toBe(true);
    expect(getPendingServiceHandoffs('claude')).toEqual([]);
    expect(
      requireDatabase()
        .prepare('SELECT status,last_error FROM service_handoffs WHERE id=?')
        .get(handoff.id),
    ).toMatchObject({
      status: 'failed',
      last_error: 'interrupted_by_user_stop',
    });
    expect(getWorkItemById(work.id)).toMatchObject({
      status: 'delivered',
      last_error: 'interrupted_by_user_stop',
      result_payload: 'Old final',
    });
    expect(
      requireDatabase()
        .prepare('SELECT * FROM paired_task_execution_leases WHERE task_id=?')
        .all(original.id),
    ).toEqual([]);
    const enqueue = vi.fn();
    expect(requeueRecoverablePendingPairedFollowUps({ enqueue })).toBe(0);
    const identity = buildPairedTurnIdentity({
      taskId: original.id,
      taskUpdatedAt: original.updated_at,
      intentKind: 'owner-turn',
    });
    expect(getPairedTurnAttempts(identity.turnId).at(-1)?.state).toBe(
      'cancelled',
    );
  });

  it.each(['owner', 'reviewer', 'arbiter'] as const)(
    'discards late %s output and completion, even after resumption',
    async (role) => {
      const original = task();
      createPairedTask(original);
      const intentKind =
        role === 'owner'
          ? 'owner-turn'
          : role === 'reviewer'
            ? 'reviewer-turn'
            : 'arbiter-turn';
      const identity = buildPairedTurnIdentity({
        taskId: original.id,
        taskUpdatedAt: original.updated_at,
        intentKind,
      });
      claimPairedTurnReservation({
        chatJid: room,
        taskId: original.id,
        taskStatus: original.status,
        roundTripCount: 2,
        taskUpdatedAt: original.updated_at,
        intentKind,
        runId: 'old-run',
      });
      const enqueueMessageCheck = vi.fn();
      const lifecycle = createPairedExecutionLifecycle({
        pairedExecutionContext: {
          task: original,
          workDir: process.cwd(),
          envOverrides: {},
        },
        pairedTurnIdentity: identity,
        completedRole: role,
        chatJid: room,
        runId: 'old-run',
        enqueueMessageCheck,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      pausePairedTaskForChat(room);
      resolveOwnerTaskForHumanMessage({ group, chatJid: room });
      expect(
        lifecycle.recordFinalOutputBeforeDelivery(
          'TASK_DONE\nObsolete approval',
        ),
      ).toBe(false);
      lifecycle.completeImmediately({ status: 'failed' });
      lifecycle.markStatus('succeeded');
      await lifecycle.asyncFinalize();
      expect(getPairedTaskById(original.id)).toMatchObject({
        status: 'active',
        review_phase: 'implementation',
        supervisor_state: 'runnable',
      });
      expect(getPairedTurnOutputs(original.id)).toEqual([]);
      expect(enqueueMessageCheck).not.toHaveBeenCalled();
    },
  );

  it('ignores late direct completion while paused and rejects bot-only execution preparation', () => {
    const original = task();
    createPairedTask(original);
    pausePairedTaskForChat(room);
    completePairedExecutionContext({
      taskId: original.id,
      role: 'reviewer',
      status: 'succeeded',
      summary: 'TASK_DONE',
    });
    expect(getPairedTaskById(original.id)?.supervisor_state).toBe(
      'waiting_user',
    );
    expect(() =>
      preparePairedExecutionContext({
        group,
        chatJid: room,
        runId: 'bot-only',
        roomRoleContext: ownerContext,
        hasHumanMessage: false,
      }),
    ).toThrow('requires a new human instruction');
  });

  it('does not create or reopen a task in an idle or completed room', () => {
    expect(pausePairedTaskForChat(room)).toBe(false);
    createPairedTask(task({ status: 'completed', completion_reason: 'done' }));
    expect(pausePairedTaskForChat(room)).toBe(false);
    expect(getPairedTaskById('same-goal')?.completion_reason).toBe('done');
  });

  it('changes neither another room nor its execution lease', () => {
    createPairedTask(task());
    const other = task({ id: 'other-goal', chat_jid: 'dc:other-room' });
    createPairedTask(other);
    claimPairedTurnReservation({
      chatJid: other.chat_jid,
      taskId: other.id,
      taskStatus: other.status,
      roundTripCount: 2,
      taskUpdatedAt: other.updated_at,
      intentKind: 'owner-turn',
      runId: 'other-run',
    });
    pausePairedTaskForChat(room);
    expect(getPairedTaskById(other.id)).toMatchObject({
      status: 'active',
      supervisor_state: 'runnable',
      updated_at: other.updated_at,
    });
    expect(getPairedTurnsForTask(other.id)[0]?.state).toBe('running');
    expect(
      requireDatabase()
        .prepare(
          'SELECT claimed_run_id FROM paired_task_execution_leases WHERE task_id=?',
        )
        .get(other.id),
    ).toMatchObject({ claimed_run_id: 'other-run' });
  });

  it('uses different revisions for repeated stop/resume cycles in the same millisecond', () => {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-27T00:00:00.000Z'));
    try {
      createPairedTask(task());
      const revisions = new Set<string>();
      for (let i = 0; i < 2; i++) {
        pausePairedTaskForChat(room);
        revisions.add(getPairedTaskById('same-goal')!.updated_at);
        const resumed = resolveOwnerTaskForHumanMessage({
          group,
          chatJid: room,
        }).task!;
        revisions.add(resumed.updated_at);
        expect(resumed.id).toBe('same-goal');
      }
      expect(revisions.size).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a normal arbiter REVISE directive enforceable in a new episode', () => {
    createPairedTask(
      task({
        episode_number: 5,
        arbiter_verdict: 'revise',
        supervisor_state_changed_at: '2026-10-01T00:02:00.000Z',
      }),
    );
    insertPairedTurnOutput(
      'same-goal',
      1,
      'arbiter',
      'REVISE\nOWNER_ACTION: file-edit',
      {
        createdAt: '2026-10-01T00:01:59.000Z',
      },
    );
    const prepared = preparePairedExecutionContext({
      group,
      chatJid: room,
      runId: 'arbiter-revision',
      roomRoleContext: ownerContext,
      hasHumanMessage: false,
    });
    expect(prepared?.ownerRequiredAction).toBe('file-edit');
  });
});
