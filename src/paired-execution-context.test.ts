import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLAUDE_REVIEWER_READONLY_ENV,
  REVIEWER_RUNTIME_ENV,
} from 'rbclaw-runners-shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => {
  const updatePairedTask = vi.fn();
  return {
    cancelPairedTurn: vi.fn(),
    createPairedTask: vi.fn(),
    getLatestPairedTaskForChat: vi.fn(),
    getLatestOpenPairedTaskForChat: vi.fn(),
    getPairedTaskById: vi.fn(),
    getPairedTurnById: vi.fn(),
    getPairedTurnOutputs: vi.fn(() => []),
    insertPairedTurnOutput: vi.fn(),
    updatePairedTask,
    updatePairedTaskIfUnchanged: vi.fn((id, _expectedUpdatedAt, updates) => {
      updatePairedTask(id, updates);
      return true;
    }),
    hasActiveCiWatcherForChat: vi.fn(() => false),
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

import * as db from './db.js';
import * as config from './config.js';
import {
  completePairedExecutionContext,
  preparePairedExecutionContext,
  resolveOwnerTaskForHumanMessage,
} from './paired-execution-context.js';
import { resolveCanonicalSourceRef } from './paired-source-ref.js';
import type { PairedTask, RegisteredGroup, RoomRoleContext } from './types.js';

const group: RegisteredGroup = {
  name: 'Paired Room',
  folder: 'paired-room',
  trigger: '@codex',
  added_at: '2026-03-28T00:00:00.000Z',
  agentType: 'codex',
  workDir: '/tmp',
};

const ownerContext: RoomRoleContext = {
  serviceId: config.CODEX_MAIN_SERVICE_ID,
  role: 'owner',
  ownerServiceId: config.CODEX_MAIN_SERVICE_ID,
  reviewerServiceId: config.REVIEWER_SERVICE_ID_FOR_TYPE,
  failoverOwner: false,
};

const reviewerContext: RoomRoleContext = {
  serviceId: config.REVIEWER_SERVICE_ID_FOR_TYPE,
  role: 'reviewer',
  ownerServiceId: config.CODEX_MAIN_SERVICE_ID,
  reviewerServiceId: config.REVIEWER_SERVICE_ID_FOR_TYPE,
  failoverOwner: false,
};

const failoverOwnerContext: RoomRoleContext = {
  serviceId: config.CODEX_REVIEW_SERVICE_ID,
  role: 'owner',
  ownerServiceId: config.CODEX_REVIEW_SERVICE_ID,
  reviewerServiceId: config.REVIEWER_SERVICE_ID_FOR_TYPE,
  failoverOwner: true,
};

const ORIGINAL_UNSAFE_HOST_PAIRED_MODE =
  process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE;
const ORIGINAL_REVIEWER_RUNTIME = process.env[REVIEWER_RUNTIME_ENV];
const ORIGINAL_CLAUDE_REVIEWER_READONLY =
  process.env[CLAUDE_REVIEWER_READONLY_ENV];

function createCanonicalRepoWithCommit(commitMessage: string): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-finalize-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `${commitMessage}\n`);
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', commitMessage], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  return repoDir;
}

function createNestedRepoWithCommit(parentDir: string): void {
  const repoDir = path.join(parentDir, 'modules', 'management');
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  fs.writeFileSync(path.join(repoDir, 'nested.txt'), 'nested\n');
  execFileSync('git', ['add', 'nested.txt'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'nested'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
}

function resolveTreeRef(repoDir: string): string {
  return resolveCanonicalSourceRef(repoDir);
}

function buildPairedTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'dc:test',
    group_folder: group.folder,
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

function resetPairedContextTestState(): void {
  delete process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE;
  delete process.env[REVIEWER_RUNTIME_ENV];
  delete process.env[CLAUDE_REVIEWER_READONLY_ENV];
  vi.resetAllMocks();
  vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(undefined);
  vi.mocked(db.getPairedTaskById).mockReturnValue(undefined);
}

function restorePairedContextEnv(): void {
  if (ORIGINAL_UNSAFE_HOST_PAIRED_MODE == null) {
    delete process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE;
  } else {
    process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE =
      ORIGINAL_UNSAFE_HOST_PAIRED_MODE;
  }

  if (ORIGINAL_REVIEWER_RUNTIME == null) {
    delete process.env[REVIEWER_RUNTIME_ENV];
  } else {
    process.env[REVIEWER_RUNTIME_ENV] = ORIGINAL_REVIEWER_RUNTIME;
  }

  if (ORIGINAL_CLAUDE_REVIEWER_READONLY == null) {
    delete process.env[CLAUDE_REVIEWER_READONLY_ENV];
  } else {
    process.env[CLAUDE_REVIEWER_READONLY_ENV] =
      ORIGINAL_CLAUDE_REVIEWER_READONLY;
  }
}

function registerPairedContextHooks(): void {
  beforeEach(resetPairedContextTestState);
  afterAll(restorePairedContextEnv);
}

describe('paired execution context owner task preparation', () => {
  registerPairedContextHooks();

  it('creates an owner execution in the configured work directory', () => {
    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-1',
      roomRoleContext: ownerContext,
      hasHumanMessage: true,
    });

    expect(db.createPairedTask).toHaveBeenCalledTimes(1);
    expect(db.createPairedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_service_id: config.CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: config.REVIEWER_SERVICE_ID_FOR_TYPE,
        status: 'active',
        owner_agent_type: 'codex',
        reviewer_agent_type: config.REVIEWER_AGENT_TYPE,
        arbiter_agent_type: config.ARBITER_AGENT_TYPE ?? null,
        work_dir: '/tmp',
      }),
    );
    expect(result?.envOverrides).toMatchObject({
      RBCLAW_WORK_DIR: '/tmp',
      RBCLAW_PAIRED_ROLE: 'owner',
    });
  });

  it('does not carry forward the latest owner final by default when a merge_ready task is superseded by new human input', () => {
    const supersededTask = buildPairedTask({
      id: 'task-superseded',
      status: 'merge_ready',
      updated_at: '2026-03-28T00:05:00.000Z',
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(
      supersededTask,
    );
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-superseded',
        turn_number: 1,
        role: 'owner',
        output_text: 'DONE_WITH_CONCERNS\n이전 task owner final',
        created_at: '2026-03-28T00:01:00.000Z',
      },
      {
        id: 2,
        task_id: 'task-superseded',
        turn_number: 2,
        role: 'reviewer',
        output_text: 'DONE\nreview approved',
        created_at: '2026-03-28T00:02:00.000Z',
      },
    ]);

    const result = resolveOwnerTaskForHumanMessage({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
      existingTask: supersededTask,
    });

    expect(db.createPairedTask).toHaveBeenCalledTimes(1);
    expect(result.supersededTask).toEqual(supersededTask);
    expect(db.insertPairedTurnOutput).not.toHaveBeenCalled();
  });

  it('records a quick reopen when a new owner task starts shortly after TASK_DONE completion', () => {
    const previousTask = buildPairedTask({
      id: 'task-completed',
      status: 'completed',
      completion_reason: 'done',
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      task_done_then_user_reopen_count: 0,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(undefined);
    vi.mocked(db.getLatestPairedTaskForChat).mockReturnValue(previousTask);

    const result = resolveOwnerTaskForHumanMessage({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
      existingTask: null,
    });

    expect(result.task).not.toBeNull();
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-completed',
      expect.objectContaining({
        task_done_then_user_reopen_count: 1,
      }),
    );
  });

  it('resets active STEP_DONE loop counters when a new human message continues an active task', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(
      buildPairedTask({
        status: 'active',
        owner_failure_count: 1,
        owner_step_done_streak: 2,
        empty_step_done_streak: 2,
      }),
    );

    preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-human-reset-step-done-loop',
      roomRoleContext: ownerContext,
      hasHumanMessage: true,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 0,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
      }),
    );
  });

  it('uses room role context agent overrides when creating a paired task', () => {
    preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-room-overrides',
      roomRoleContext: {
        ...ownerContext,
        ownerAgentType: 'codex',
        reviewerAgentType: 'codex',
        reviewerServiceId: config.CODEX_REVIEW_SERVICE_ID,
        arbiterAgentType: 'claude-code',
      },
      hasHumanMessage: true,
    });

    expect(db.createPairedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_service_id: config.CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: config.CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'codex',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: 'claude-code',
      }),
    );
  });

  it('persists stable role-slot service shadow instead of the transient failover owner lease', () => {
    preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-failover-owner',
      roomRoleContext: failoverOwnerContext,
      hasHumanMessage: true,
    });

    expect(db.createPairedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_service_id: config.CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: config.REVIEWER_SERVICE_ID_FOR_TYPE,
        owner_agent_type: 'codex',
        reviewer_agent_type: config.REVIEWER_AGENT_TYPE,
      }),
    );
  });
});

describe('paired execution context reviewer preparation', () => {
  registerPairedContextHooks();

  it('uses the task work directory directly and marks the task in_review', () => {
    const task = buildPairedTask({
      status: 'review_ready',
      review_requested_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(task);
    vi.mocked(db.getPairedTaskById).mockReturnValue(task);

    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-2',
      roomRoleContext: reviewerContext,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'in_review' }),
    );
    expect(result?.workDir).toBe('/tmp');
    expect(result?.envOverrides).toMatchObject({
      RBCLAW_WORK_DIR: '/tmp',
      RBCLAW_REVIEWER_RUNTIME: '1',
      RBCLAW_PAIRED_ROLE: 'reviewer',
    });
  });

  it('preserves the claimed reviewer turn revision for in-review continuations and requires a visible verdict', () => {
    const task = buildPairedTask({
      status: 'in_review',
      review_requested_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:05:00.000Z',
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(task);
    vi.mocked(db.getPairedTaskById).mockReturnValue(task);

    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-review-continuation',
      roomRoleContext: reviewerContext,
      pairedTurnIdentity: {
        turnId: 'task-1:2026-03-28T00:00:00.000Z:reviewer-turn',
        taskId: 'task-1',
        taskUpdatedAt: '2026-03-28T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
    });

    expect(result?.claimedTaskUpdatedAt).toBe('2026-03-28T00:00:00.000Z');
    expect(result?.requiresVisibleVerdict).toBe(true);
    expect(db.updatePairedTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'in_review' }),
    );
  });

  it('does not create a paired execution without a configured workDir', () => {
    const result = preparePairedExecutionContext({
      group: { ...group, workDir: undefined },
      chatJid: 'dc:test',
      runId: 'run-missing-work-dir',
      roomRoleContext: reviewerContext,
    });

    expect(result).toBeUndefined();
  });
});

describe('paired execution context unsafe host reviewer runtime', () => {
  registerPairedContextHooks();

  it('routes reviewer to host mode when unsafe host paired mode is enabled', () => {
    process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE = '1';
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(
      buildPairedTask({
        status: 'review_ready',
        review_requested_at: '2026-03-28T00:00:00.000Z',
      }),
    );
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'review_ready',
        review_requested_at: '2026-03-28T00:00:00.000Z',
      }),
    );
    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-host-reviewer',
      roomRoleContext: reviewerContext,
    });

    expect(result?.envOverrides).toMatchObject({
      RBCLAW_WORK_DIR: '/tmp',
      RBCLAW_PAIRED_ROLE: 'reviewer',
      RBCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
    });
    expect(result?.envOverrides.RBCLAW_CLAUDE_REVIEWER_READONLY).toBe('1');
    expect(result?.envOverrides.RBCLAW_REVIEWER_RUNTIME).toBeUndefined();
    expect(result?.envOverrides.CLAUDE_CONFIG_DIR).toContain(
      '/data/sessions/paired-room-reviewer',
    );
    delete process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE;
  });

  it('honors room-level reviewer agent overrides for unsafe host reviewer runtime env', () => {
    process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE = '1';
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(
      buildPairedTask({
        status: 'review_ready',
        review_requested_at: '2026-03-28T00:00:00.000Z',
        reviewer_agent_type: 'codex',
      }),
    );
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'review_ready',
        review_requested_at: '2026-03-28T00:00:00.000Z',
        reviewer_agent_type: 'codex',
      }),
    );
    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-host-reviewer-room-override',
      roomRoleContext: {
        ...reviewerContext,
        reviewerAgentType: 'codex',
      },
    });

    expect(result?.envOverrides).toMatchObject({
      RBCLAW_WORK_DIR: '/tmp',
      RBCLAW_PAIRED_ROLE: 'reviewer',
      RBCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
    });
    expect(
      result?.envOverrides.RBCLAW_CLAUDE_REVIEWER_READONLY,
    ).toBeUndefined();
    expect(result?.envOverrides.RBCLAW_REVIEWER_RUNTIME).toBeUndefined();
    delete process.env.RBCLAW_UNSAFE_HOST_PAIRED_MODE;
  });
});

describe('paired execution context owner completion handling', () => {
  registerPairedContextHooks();

  it('completePairedExecutionContext logs without error', () => {
    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'done',
    });

    // Should not throw; just logs.
  });

  it('ignores late completions after the paired task is already completed', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'completed',
        completion_reason: 'done',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });

    expect(db.updatePairedTask).not.toHaveBeenCalled();
  });

  it('completes owner finalize when only the commit object changed after approval', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'metadata only'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
        work_dir: repoDir,
        source_ref: approvedSourceRef,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('completes owner finalize with an unchanged nested repository', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    createNestedRepoWithCommit(repoDir);
    const approvedSourceRef = resolveTreeRef(repoDir);

    expect(approvedSourceRef).toMatch(/^workdir-v1:[a-f0-9]{64}$/);
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
        work_dir: repoDir,
        source_ref: approvedSourceRef,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'TASK_DONE',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('requests review when the owner reports STEP_DONE in active mode', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        round_trip_count: 1,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'STEP_DONE\n1단계 완료, 후속 작업 계속',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 2,
        owner_step_done_streak: 1,
        empty_step_done_streak: 0,
      }),
    );
  });
});

describe('paired execution context STEP_DONE deadlock handling', () => {
  registerPairedContextHooks();

  it('requests arbiter when active STEP_DONE repeats without code changes', () => {
    vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(true);

    const repoDir = createCanonicalRepoWithCommit('active step done loop');
    const sourceRef = resolveTreeRef(repoDir);
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        work_dir: repoDir,
        source_ref: sourceRef,
        owner_step_done_streak: 2,
        empty_step_done_streak: 2,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'STEP_DONE\n요약만 반복되고 코드 변경은 없음',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        arbiter_requested_at: expect.any(String),
        owner_step_done_streak: 3,
        empty_step_done_streak: 3,
      }),
    );
  });

  it('re-triggers review when the owner reports STEP_DONE during finalize', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    const task = buildPairedTask({
      status: 'merge_ready',
      work_dir: repoDir,
      source_ref: approvedSourceRef,
      round_trip_count: 1,
    });
    vi.mocked(db.getPairedTaskById)
      .mockReturnValueOnce(task)
      .mockReturnValueOnce({ ...task, status: 'active' })
      .mockReturnValue({ ...task, status: 'review_ready' });

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'STEP_DONE\n남은 범위가 있어서 계속 진행',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        owner_failure_count: 0,
        finalize_step_done_count: 1,
        empty_step_done_streak: 1,
      }),
    );
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 2,
        finalize_step_done_count: 1,
        empty_step_done_streak: 1,
      }),
    );
  });

  it('requests arbiter when finalize STEP_DONE repeats without code changes', () => {
    vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(true);

    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
        work_dir: repoDir,
        source_ref: approvedSourceRef,
        empty_step_done_streak: 1,
        finalize_step_done_count: 1,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'STEP_DONE\n아직 남았지만 코드 변경은 없음',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        empty_step_done_streak: 2,
        finalize_step_done_count: 2,
      }),
    );
  });
});

describe('paired execution context finalize re-review handling', () => {
  registerPairedContextHooks();

  it('re-triggers review once when owner reports DONE_WITH_CONCERNS during finalize', () => {
    const task = buildPairedTask({
      status: 'merge_ready',
      round_trip_count: 1,
    });
    vi.mocked(db.getPairedTaskById)
      .mockReturnValueOnce(task)
      .mockReturnValueOnce({ ...task, status: 'active' })
      .mockReturnValue({ ...task, status: 'review_ready' });

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE_WITH_CONCERNS\n\nneeds another reviewer pass',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
      }),
    );
    const returnToActiveOrder = vi
      .mocked(db.updatePairedTask)
      .mock.calls.findIndex(
        ([id, patch]) => id === 'task-1' && patch.status === 'active',
      );
    expect(returnToActiveOrder).toBeGreaterThanOrEqual(0);
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 2,
      }),
    );
  });

  it('re-triggers review when owner changed code after approval', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'changed\n');
    execFileSync('git', ['add', 'README.md'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'code change'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    const task = buildPairedTask({
      status: 'merge_ready',
      work_dir: repoDir,
      source_ref: approvedSourceRef,
      round_trip_count: 1,
    });
    vi.mocked(db.getPairedTaskById)
      .mockReturnValueOnce(task)
      .mockReturnValueOnce({ ...task, status: 'active' })
      .mockReturnValue({ ...task, status: 'review_ready' });

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
      }),
    );
    const returnToActiveOrder = vi
      .mocked(db.updatePairedTask)
      .mock.calls.findIndex(
        ([id, patch]) => id === 'task-1' && patch.status === 'active',
      );
    expect(returnToActiveOrder).toBeGreaterThanOrEqual(0);
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 2,
      }),
    );
  });

  it('marks review_ready but defers reviewer enqueue when an active CI watcher exists', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        round_trip_count: 0,
      }),
    );
    vi.mocked(db.hasActiveCiWatcherForChat).mockReturnValue(true);

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 1,
      }),
    );
  });
});

describe('paired execution context finalize escalation handling', () => {
  registerPairedContextHooks();

  it('requests arbiter instead of re-reviewing when repeated DONE finalize loops exceed the threshold', () => {
    vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(true);

    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'changed again\n');
    execFileSync('git', ['add', 'README.md'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'code change'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
        work_dir: repoDir,
        source_ref: approvedSourceRef,
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        arbiter_requested_at: expect.any(String),
      }),
    );
  });

  it.each(['BLOCKED', 'NEEDS_CONTEXT'])(
    'escalates immediately when owner reports %s during finalize without arbiter',
    (summary) => {
      vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(false);

      vi.mocked(db.getPairedTaskById).mockReturnValue(
        buildPairedTask({
          status: 'merge_ready',
          round_trip_count: 1,
        }),
      );

      completePairedExecutionContext({
        taskId: 'task-1',
        role: 'owner',
        status: 'succeeded',
        summary,
      });

      expect(db.updatePairedTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'completed',
          completion_reason: 'escalated',
        }),
      );
    },
  );

  it.each(['BLOCKED', 'NEEDS_CONTEXT'])(
    'escalates immediately when owner reports %s during a normal turn without arbiter',
    (summary) => {
      vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(false);

      vi.mocked(db.getPairedTaskById).mockReturnValue(
        buildPairedTask({
          status: 'active',
          round_trip_count: 0,
        }),
      );

      completePairedExecutionContext({
        taskId: 'task-1',
        role: 'owner',
        status: 'succeeded',
        summary,
      });

      expect(db.updatePairedTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'completed',
          completion_reason: 'escalated',
        }),
      );
    },
  );
});

describe('paired execution context failed execution handling', () => {
  registerPairedContextHooks();

  it('records source_ref when reviewer verdict DONE arrives via failed fallback', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);

    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        work_dir: repoDir,
        source_ref: 'stale-ref',
        owner_step_done_streak: 2,
        empty_step_done_streak: 2,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary: 'DONE',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'merge_ready',
        source_ref: approvedSourceRef,
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
      }),
    );
  });

  it('keeps reviewer tasks review_ready when reviewer execution fails without a terminal verdict', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary: 'runtime exploded before verdict',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'review_ready',
        updated_at: expect.any(String),
      }),
    );
  });

  it('keeps arbiter tasks arbiter_requested when arbiter execution fails without a terminal verdict', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'failed',
      summary: 'runtime exploded before verdict',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        updated_at: expect.any(String),
      }),
    );
  });

  it('increments owner failure count and resets owner tasks to active after failed execution', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary: 'push failed',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        owner_failure_count: 1,
        updated_at: expect.any(String),
      }),
    );
  });

  it('requests arbiter after repeated owner execution failures without a visible verdict', () => {
    vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(true);
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        owner_failure_count: 1,
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary:
        "Error running remote compact task: Unknown parameter: 'prompt_cache_retention'",
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        owner_failure_count: 2,
        arbiter_requested_at: expect.any(String),
      }),
    );
  });

  it('releases the execution lease even when a completion handler throws', () => {
    const transitionError = new Error('transition failed');
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
      }),
    );
    vi.mocked(db.updatePairedTaskIfUnchanged).mockImplementationOnce(() => {
      throw transitionError;
    });

    expect(() =>
      completePairedExecutionContext({
        taskId: 'task-1',
        role: 'owner',
        status: 'failed',
        runId: 'run-lease-release',
        summary: 'push failed',
      }),
    ).toThrow('transition failed');
    expect(db.releasePairedTaskExecutionLease).toHaveBeenCalledWith({
      taskId: 'task-1',
      runId: 'run-lease-release',
    });
  });
});

describe('paired execution context completion lease cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('propagates completion handler errors when no execution lease was reserved', () => {
    const transitionError = new Error('transition failed without lease');
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
      }),
    );
    vi.mocked(db.updatePairedTaskIfUnchanged).mockImplementationOnce(() => {
      throw transitionError;
    });

    expect(() =>
      completePairedExecutionContext({
        taskId: 'task-1',
        role: 'owner',
        status: 'failed',
        summary: 'push failed',
      }),
    ).toThrow('transition failed without lease');
    expect(db.releasePairedTaskExecutionLease).not.toHaveBeenCalled();
  });
});

describe('paired execution context reviewer failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('moves failed reviewer STEP_DONE output back to active for owner follow-up', () => {
    const task = buildPairedTask({
      status: 'in_review',
      updated_at: '2026-03-28T00:05:00.000Z',
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue(task);

    completePairedExecutionContext({
      taskId: task.id,
      role: 'reviewer',
      status: 'failed',
      runId: 'run-failed-reviewer-step-done',
      summary: 'STEP_DONE\n오너 수정이 더 필요합니다.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        status: 'active',
      }),
    );
    expect(db.releasePairedTaskExecutionLease).toHaveBeenCalledWith({
      taskId: task.id,
      runId: 'run-failed-reviewer-step-done',
    });
  });
});
