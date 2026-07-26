import { describe, expect, it } from 'vitest';

import {
  assertPairedSupervisorTransition,
  isPairedTaskRunnable,
} from './paired-supervisor-state.js';
import type { PairedTask } from './types.js';

function task(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'goal-1',
    chat_jid: 'dc:paired',
    group_folder: 'paired-room',
    work_dir: '/tmp/paired-room',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'codex-review',
    title: null,
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    episode_number: 1,
    total_round_trip_count: 0,
    arbitration_count: 0,
    stagnation_count: 0,
    progress_fingerprint: null,
    last_blocker_class: null,
    resume_at: null,
    supervisor_state: 'runnable',
    supervisor_state_changed_at: '2026-07-27T00:00:00.000Z',
    last_arbiter_directive_fingerprint: null,
    last_arbiter_directive_json: null,
    retry_count: 0,
    external_wait_ref: null,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('paired supervisor state', () => {
  it('allows bounded waiting and terminal transitions', () => {
    expect(() =>
      assertPairedSupervisorTransition({
        currentState: 'runnable',
        nextState: 'waiting_retry',
      }),
    ).not.toThrow();
    expect(() =>
      assertPairedSupervisorTransition({
        currentState: 'waiting_retry',
        nextState: 'runnable',
      }),
    ).not.toThrow();
    expect(() =>
      assertPairedSupervisorTransition({
        currentState: 'runnable',
        nextState: 'terminal',
      }),
    ).not.toThrow();
  });

  it('never resumes a terminal goal', () => {
    expect(() =>
      assertPairedSupervisorTransition({
        currentState: 'terminal',
        nextState: 'runnable',
      }),
    ).toThrow('Invalid paired supervisor transition: terminal -> runnable');
  });

  it('gates waiting, parked, and completed tasks', () => {
    expect(isPairedTaskRunnable(task())).toBe(true);
    expect(
      isPairedTaskRunnable(task({ supervisor_state: 'waiting_user' })),
    ).toBe(false);
    expect(
      isPairedTaskRunnable(task({ supervisor_state: 'waiting_external' })),
    ).toBe(false);
    expect(
      isPairedTaskRunnable(
        task({
          supervisor_state: 'waiting_retry',
          resume_at: '2099-01-01T00:00:00.000Z',
        }),
        new Date('2026-07-27T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isPairedTaskRunnable(
        task({
          supervisor_state: 'waiting_retry',
          resume_at: '2026-07-26T00:00:00.000Z',
        }),
        new Date('2026-07-27T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isPairedTaskRunnable(
        task({ status: 'completed', supervisor_state: 'terminal' }),
      ),
    ).toBe(false);
  });
});
