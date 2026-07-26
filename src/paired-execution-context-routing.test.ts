import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => {
  const updatePairedTask = vi.fn();
  return {
    getPairedTaskById: vi.fn(),
    updatePairedTask,
    updatePairedTaskIfUnchanged: vi.fn((id, _expectedUpdatedAt, updates) => {
      updatePairedTask(id, updates);
      return true;
    }),
    releasePairedTaskExecutionLease: vi.fn(),
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as config from './config.js';
import * as db from './db.js';
import { completePairedExecutionContext } from './paired-execution-context.js';
import type { PairedTask } from './types.js';

function buildPairedTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'dc:test',
    group_folder: 'rbclaw',
    work_dir: '/tmp',
    owner_service_id: config.CODEX_MAIN_SERVICE_ID,
    reviewer_service_id: config.REVIEWER_SERVICE_ID_FOR_TYPE,
    title: null,
    source_ref: 'HEAD',
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
    ...overrides,
  };
}

function resetRoutingMocks(): void {
  vi.clearAllMocks();
}

describe('paired execution routing loop guards: reviewer approvals', () => {
  beforeEach(resetRoutingMocks);

  it('clears stale owner loop state when reviewer approves normally', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        source_ref: 'HEAD',
        owner_failure_count: 1,
        owner_step_done_streak: 3,
        finalize_step_done_count: 1,
        empty_step_done_streak: 2,
        arbiter_verdict: 'proceed',
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'succeeded',
      summary: 'TASK_DONE\n승인',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'merge_ready',
        source_ref: 'HEAD',
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
      }),
    );
  });

  it('clears stale owner loop state when reviewer approval is recovered from a failed run', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        source_ref: 'approved-ref',
        owner_step_done_streak: 2,
        empty_step_done_streak: 2,
        arbiter_verdict: 'proceed',
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary: 'DONE\n승인',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'merge_ready',
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
      }),
    );
  });
});

describe('paired execution routing loop guards: arbiter verdicts', () => {
  beforeEach(resetRoutingMocks);

  it('routes arbiter PROCEED back to reviewer instead of owner ping-pong', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        episode_number: 2,
        total_round_trip_count: 9,
        arbitration_count: 1,
        owner_step_done_streak: 3,
        finalize_step_done_count: 1,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'PROCEED\nReviewer should approve.',
      arbiterDirective: {
        verdict: 'proceed',
        requirements: [],
        blockers: [],
      },
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'review_ready',
        round_trip_count: 0,
        episode_number: 3,
        total_round_trip_count: 9,
        arbitration_count: 1,
        supervisor_state: 'runnable',
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: 'proceed',
        arbiter_requested_at: null,
      }),
    );
  });

  it('keeps arbiter ESCALATE open so the next human approval keeps task context', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        episode_number: 4,
        total_round_trip_count: 12,
        arbitration_count: 2,
        owner_failure_count: 1,
        owner_step_done_streak: 3,
        finalize_step_done_count: 1,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'ESCALATE\nUser should approve the prod release.',
      arbiterDirective: {
        verdict: 'escalate',
        requirements: [],
        blockers: [
          { id: 'user-approval', scope: 'production', action: 'approve' },
        ],
      },
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        round_trip_count: 0,
        episode_number: 5,
        total_round_trip_count: 12,
        arbitration_count: 2,
        supervisor_state: 'waiting_user',
        last_blocker_class: 'user_input',
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: 'escalate',
        arbiter_requested_at: null,
        completion_reason: null,
      }),
    );
  });

  it('requests one correction when the Arbiter directive is missing', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        episode_number: 7,
        total_round_trip_count: 14,
        arbitration_count: 2,
        owner_step_done_streak: 3,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'No formal verdict, but this should not re-run owner.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        owner_failure_count: 1,
        last_blocker_class: 'protocol',
      }),
    );
  });

  it('waits for the user after a repeated missing Arbiter directive', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        owner_failure_count: 1,
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        total_round_trip_count: 14,
        arbitration_count: 2,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'REVISE\nStill no structured directive.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        supervisor_state: 'waiting_user',
        owner_failure_count: 2,
        last_blocker_class: 'protocol',
      }),
    );
  });
});

describe('paired execution routing loop guards: terminal failures and owner revise', () => {
  beforeEach(resetRoutingMocks);

  it('returns arbiter terminal Codex account failures to owner without re-arming arbiter', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        owner_failure_count: 1,
        owner_step_done_streak: 3,
        finalize_step_done_count: 1,
        empty_step_done_streak: 2,
        arbiter_verdict: 'revise',
        arbiter_requested_at: '2026-03-28T00:00:04.000Z',
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'failed',
      summary:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        owner_failure_count: 2,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
      }),
    );
  });

  it('completes reviewer task after terminal Codex account failure instead of preserving review_ready loop', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        arbiter_verdict: 'escalate',
        arbiter_requested_at: null,
        completion_reason: 'reviewer_codex_unavailable',
      }),
    );
  });

  it('preserves owner task after terminal Codex account failure instead of completing silently', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        owner_failure_count: 1,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
      }),
    );
  });

  it('parks hard turn timeouts in waiting_retry instead of immediately retrying', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        retry_count: 1,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary: 'Agent hard turn timeout after 7200000ms',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'review_ready',
        supervisor_state: 'waiting_retry',
        retry_count: 2,
        last_blocker_class: 'timeout',
        resume_at: expect.any(String),
      }),
    );
  });

  it('keeps arbiter REVISE on owner flow while clearing stale loop counters', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        episode_number: 7,
        total_round_trip_count: 14,
        arbitration_count: 2,
        owner_step_done_streak: 3,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'REVISE\nOwner must fix this.',
      arbiterDirective: {
        verdict: 'revise',
        requirements: [
          { id: 'fix', scope: 'owner', action: 'correct-implementation' },
        ],
        blockers: [],
      },
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        round_trip_count: 0,
        episode_number: 8,
        total_round_trip_count: 14,
        arbitration_count: 2,
        supervisor_state: 'runnable',
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: 'revise',
        arbiter_requested_at: null,
      }),
    );
  });

  it('starts a new episode after arbiter RESET without resetting goal totals', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        episode_number: 3,
        total_round_trip_count: 11,
        arbitration_count: 2,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'RESET\nStart a fresh episode with the same goal.',
      arbiterDirective: {
        verdict: 'reset',
        requirements: [
          { id: 'restart', scope: 'episode', action: 'restart-strategy' },
        ],
        blockers: [],
      },
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        round_trip_count: 0,
        episode_number: 4,
        total_round_trip_count: 11,
        arbitration_count: 2,
        supervisor_state: 'runnable',
        arbiter_verdict: 'reset',
      }),
    );
  });
});
