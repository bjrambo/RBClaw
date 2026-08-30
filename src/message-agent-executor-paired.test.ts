import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  completePairedTurn: vi.fn(),
  failPairedTurn: vi.fn(),
  getLastHumanMessageSender: vi.fn(() => '111111111111111111'),
  getLatestTurnNumber: vi.fn(() => 0),
  getPairedTaskById: vi.fn(),
  insertPairedTurnOutput: vi.fn(),
  refreshPairedTaskExecutionLease: vi.fn(() => true),
  releasePairedTaskExecutionLease: vi.fn(),
}));

vi.mock('./paired-execution-context.js', () => ({
  completePairedExecutionContext: vi.fn(),
}));

vi.mock('./paired-turn-run-ownership.js', () => ({
  resolvePairedTurnRunOwnership: vi.fn(() => ({ state: 'active' })),
}));

vi.mock('./message-runtime-follow-up.js', () => ({
  enqueuePairedFollowUpAfterEvent: vi.fn(),
}));

import type { AgentOutput } from './agent-runner.js';
import * as db from './db.js';
import * as pairedExecutionContextModule from './paired-execution-context.js';
import { createPairedExecutionLifecycle } from './message-agent-executor-paired.js';
import { resolveCanonicalSourceRef } from './paired-source-ref.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

const tempDirs: string[] = [];

function createOwnerEvidenceRepo(): string {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rbclaw-owner-evidence-'),
  );
  tempDirs.push(repoDir);
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'initial\n');
  execFileSync('git', ['add', 'README.md'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'initial'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  return repoDir;
}

function createOwnerEvidenceLifecycle(args: {
  workDir: string;
  sourceRef: string;
  requiredAction: 'file-edit' | 'verify' | 'explain' | 'unspecified';
}) {
  return createPairedExecutionLifecycle({
    pairedExecutionContext: {
      task: {
        id: 'paired-task-owner-evidence',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        work_dir: args.workDir,
        owner_service_id: 'codex-main',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: args.sourceRef,
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: null,
        status: 'active',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-08-30T10:00:00.000Z',
        updated_at: '2026-08-30T10:00:00.000Z',
      },
      workDir: args.workDir,
      envOverrides: {},
      ownerRequiredAction: args.requiredAction,
      ownerTurnSourceRef: args.sourceRef,
      ownerTaskSourceRef: args.sourceRef,
    },
    completedRole: 'owner',
    chatJid: 'group@test',
    runId: 'run-owner-evidence',
    enqueueMessageCheck: vi.fn(),
    log,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('createPairedExecutionLifecycle owner evidence gate', () => {
  it('suppresses a required file-edit final when the worktree did not change', () => {
    const workDir = createOwnerEvidenceRepo();
    const sourceRef = resolveCanonicalSourceRef(workDir);
    const lifecycle = createOwnerEvidenceLifecycle({
      workDir,
      sourceRef,
      requiredAction: 'file-edit',
    });

    expect(
      lifecycle.recordFinalOutputBeforeDelivery('TASK_DONE\n상태: 검증만 완료'),
    ).toBe(false);
    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-owner-evidence',
      1,
      'owner',
      expect.stringContaining(
        '[RBClaw owner evidence rejected; next-action=file-edit]',
      ),
    );

    lifecycle.completeImmediately({ status: 'succeeded' });
    expect(
      pairedExecutionContextModule.completePairedExecutionContext,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRequiredAction: 'file-edit',
        ownerTurnSourceRef: sourceRef,
        ownerEvidenceRejectionReason:
          'Required file-edit action completed without a worktree change.',
      }),
    );
  });

  it('suppresses a no-change report when the task worktree changed', () => {
    const workDir = createOwnerEvidenceRepo();
    const sourceRef = resolveCanonicalSourceRef(workDir);
    const lifecycle = createOwnerEvidenceLifecycle({
      workDir,
      sourceRef,
      requiredAction: 'unspecified',
    });
    fs.writeFileSync(path.join(workDir, 'README.md'), 'changed\n');

    expect(
      lifecycle.recordFinalOutputBeforeDelivery(
        'TASK_DONE\n상태: 파일은 수정하지 않았다.',
      ),
    ).toBe(false);
    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-owner-evidence',
      1,
      'owner',
      expect.stringContaining(
        '[RBClaw owner evidence rejected; next-action=explain]',
      ),
    );
  });

  it('accepts a truthful file-edit final after a real worktree change', () => {
    const workDir = createOwnerEvidenceRepo();
    const sourceRef = resolveCanonicalSourceRef(workDir);
    const lifecycle = createOwnerEvidenceLifecycle({
      workDir,
      sourceRef,
      requiredAction: 'file-edit',
    });
    fs.writeFileSync(path.join(workDir, 'README.md'), 'changed\n');

    expect(
      lifecycle.recordFinalOutputBeforeDelivery('TASK_DONE\n상태: 구현 완료'),
    ).toBe(true);
    expect(
      pairedExecutionContextModule.completePairedExecutionContext,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRequiredAction: 'file-edit',
      }),
    );
    const completionArgs = vi
      .mocked(pairedExecutionContextModule.completePairedExecutionContext)
      .mock.calls.at(-1)?.[0];
    expect(completionArgs).not.toHaveProperty('ownerEvidenceRejectionReason');
  });
});

describe('createPairedExecutionLifecycle output persistence', () => {
  it('stores final output attachments with the paired turn output', () => {
    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-output-attachment',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          work_dir: '/tmp/rbclaw-test-work',
          owner_service_id: 'codex-main',
          reviewer_service_id: 'claude',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 0,
          review_requested_at: null,
          status: 'active',
          arbiter_verdict: null,
          arbiter_requested_at: null,
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workDir: '/tmp/rbclaw-test-work',
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-output-attachment:2026-04-09T00:00:00.000Z:owner-turn',
        taskId: 'paired-task-output-attachment',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
      completedRole: 'owner',
      chatJid: 'group@test',
      runId: 'run-output-attachment',
      enqueueMessageCheck: vi.fn(),
      log,
    });

    lifecycle.recordFinalOutputBeforeDelivery('TASK_DONE\n새 렌더 첨부', [
      {
        path: '/tmp/settings-v0.1.92-deployed-390.png',
        name: 'settings-v0.1.92-deployed-390.png',
        mime: 'image/png',
      },
    ]);

    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-output-attachment',
      1,
      'owner',
      'TASK_DONE\n새 렌더 첨부',
      {
        attachments: [
          {
            path: '/tmp/settings-v0.1.92-deployed-390.png',
            name: 'settings-v0.1.92-deployed-390.png',
            mime: 'image/png',
          },
        ],
      },
    );
  });
});

describe('createPairedExecutionLifecycle verdict routing', () => {
  it('uses the full final output for paired verdict routing', () => {
    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-long-final',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          work_dir: '/tmp/rbclaw-test-work',
          owner_service_id: 'codex-main',
          reviewer_service_id: 'claude',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 0,
          review_requested_at: null,
          status: 'active',
          arbiter_verdict: null,
          arbiter_requested_at: null,
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workDir: '/tmp/rbclaw-test-work',
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId: 'paired-task-long-final:2026-04-09T00:00:00.000Z:owner-turn',
        taskId: 'paired-task-long-final',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
      completedRole: 'owner',
      chatJid: 'group@test',
      runId: 'run-long-final',
      enqueueMessageCheck: vi.fn(),
      log,
    });
    const longPreface = '검증 증거 '.repeat(100);
    const finalOutput = `${longPreface}\nTASK_DONE\n뒤쪽 상태줄도 라우팅에 반영되어야 합니다.`;

    lifecycle.recordFinalOutputBeforeDelivery(finalOutput);

    expect(
      pairedExecutionContextModule.completePairedExecutionContext,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'paired-task-long-final',
        role: 'owner',
        status: 'succeeded',
        runId: 'run-long-final',
        summary: finalOutput,
      }),
    );
    expect(finalOutput.indexOf('TASK_DONE')).toBeGreaterThan(500);
  });
});

describe('createPairedExecutionLifecycle completion handling', () => {
  it('emits a sanitized BLOCKED notice when reviewer authentication expires', async () => {
    const outputs: AgentOutput[] = [];
    const enqueueMessageCheck = vi.fn();
    const authFailure =
      'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';

    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-reviewer-auth-expired',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'review_ready',
      supervisor_state: 'waiting_user',
      last_blocker_class: 'authentication',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });

    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-reviewer-auth-expired',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          work_dir: '/tmp/rbclaw-test-work',
          owner_service_id: 'codex-main',
          reviewer_service_id: 'claude',
          owner_agent_type: 'codex',
          reviewer_agent_type: 'claude-code',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 1,
          review_requested_at: '2026-04-09T00:00:00.000Z',
          status: 'in_review',
          arbiter_verdict: null,
          arbiter_requested_at: null,
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workDir: '/tmp/rbclaw-test-work',
        envOverrides: {},
        requiresVisibleVerdict: true,
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-reviewer-auth-expired:2026-04-09T00:00:00.000Z:reviewer-turn',
        taskId: 'paired-task-reviewer-auth-expired',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
      completedRole: 'reviewer',
      chatJid: 'group@test',
      runId: 'run-reviewer-auth-expired',
      enqueueMessageCheck,
      onOutput: async (output) => {
        outputs.push(output);
      },
      log,
    });

    lifecycle.updateSummary({ outputText: authFailure });
    lifecycle.markStatus('failed');
    lifecycle.markSawOutput(false);
    await lifecycle.asyncFinalize();

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.result).toMatch(/^BLOCKED\n/);
    expect(outputs[0]?.result).toContain(
      '리뷰어 인증이 만료되어 검토를 완료하지 못했습니다.',
    );
    expect(outputs[0]?.result).not.toContain(authFailure);
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('does not emit a second public notification after arbiter ESCALATE', async () => {
    const outputs: AgentOutput[] = [];

    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-arbiter-escalated',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'completed',
      arbiter_verdict: 'escalate',
      arbiter_requested_at: '2026-04-09T00:00:00.000Z',
      completion_reason: 'arbiter_escalated',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });

    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-arbiter-escalated',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          work_dir: '/tmp/rbclaw-test-work',
          owner_service_id: 'claude',
          reviewer_service_id: 'codex-main',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 1,
          review_requested_at: '2026-04-09T00:00:00.000Z',
          status: 'in_arbitration',
          arbiter_verdict: null,
          arbiter_requested_at: '2026-04-09T00:00:00.000Z',
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workDir: '/tmp/rbclaw-test-work',
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-arbiter-escalated:2026-04-09T00:00:00.000Z:arbiter-turn',
        taskId: 'paired-task-arbiter-escalated',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'arbiter-turn',
        role: 'arbiter',
      },
      completedRole: 'arbiter',
      chatJid: 'group@test',
      runId: 'run-arbiter-escalated',
      enqueueMessageCheck: vi.fn(),
      onOutput: async (output) => {
        outputs.push(output);
      },
      log,
    });

    lifecycle.recordFinalOutputBeforeDelivery(
      'ESCALATE\nuser decision required',
    );
    lifecycle.markStatus('succeeded');
    lifecycle.markSawOutput(true);
    await lifecycle.asyncFinalize();

    expect(outputs).toEqual([]);
  });

  it('releases an owner turn interrupted by a human message without counting an owner failure', async () => {
    const enqueueMessageCheck = vi.fn();
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-human-interrupted',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });

    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-human-interrupted',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          work_dir: '/tmp/rbclaw-test-work',
          owner_service_id: 'claude',
          reviewer_service_id: 'codex-main',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 1,
          review_requested_at: '2026-04-09T00:00:00.000Z',
          status: 'active',
          arbiter_verdict: null,
          arbiter_requested_at: null,
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workDir: '/tmp/rbclaw-test-work',
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-human-interrupted:2026-04-09T00:00:00.000Z:owner-turn',
        taskId: 'paired-task-human-interrupted',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
      completedRole: 'owner',
      chatJid: 'group@test',
      runId: 'run-human-interrupted',
      enqueueMessageCheck,
      getCloseReason: () => 'human-message-detected',
      log,
    });

    expect(
      lifecycle.recordFinalOutputBeforeDelivery(
        'TASK_DONE\n부분 진행 결과를 닫기 전에 내보냅니다.',
      ),
    ).toBe(false);
    lifecycle.updateSummary({
      outputText: '아비터 판단을 내리겠습니다.',
    });
    lifecycle.markStatus('succeeded');
    lifecycle.markSawOutput(false);
    await lifecycle.asyncFinalize();

    expect(
      pairedExecutionContextModule.completePairedExecutionContext,
    ).not.toHaveBeenCalled();
    expect(db.insertPairedTurnOutput).not.toHaveBeenCalled();
    expect(db.releasePairedTaskExecutionLease).toHaveBeenCalledWith({
      taskId: 'paired-task-human-interrupted',
      runId: 'run-human-interrupted',
    });
    expect(db.failPairedTurn).toHaveBeenCalledWith({
      turnIdentity: expect.objectContaining({
        taskId: 'paired-task-human-interrupted',
        role: 'owner',
      }),
      error: '아비터 판단을 내리겠습니다.',
    });
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});
