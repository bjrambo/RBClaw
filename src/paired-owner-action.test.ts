import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assessOwnerCompletionEvidence,
  buildRejectedOwnerOutput,
  resolveOwnerRequiredAction,
} from './paired-owner-action.js';
import { resolveCanonicalSourceRef } from './paired-source-ref.js';
import type { PairedTurnOutput } from './types.js';

const tempDirs: string[] = [];

function createRepo(): string {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rbclaw-owner-action-'),
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

function makeOutput(
  role: PairedTurnOutput['role'],
  outputText: string,
): PairedTurnOutput {
  return {
    id: 1,
    task_id: 'task-1',
    turn_number: 1,
    role,
    output_text: outputText,
    created_at: '2026-08-30T10:00:00.000Z',
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('resolveOwnerRequiredAction', () => {
  it('uses an explicit reviewer action marker', () => {
    expect(
      resolveOwnerRequiredAction([
        makeOutput(
          'reviewer',
          'STEP_DONE\nOWNER_ACTION: verify\n검증을 다시 실행해라.',
        ),
      ]),
    ).toBe('verify');
  });

  it('keeps legacy reviewer and arbiter correction verdicts actionable', () => {
    expect(
      resolveOwnerRequiredAction([
        makeOutput('reviewer', 'STEP_DONE\n실제 파일을 수정해라.'),
      ]),
    ).toBe('file-edit');
    expect(
      resolveOwnerRequiredAction([
        makeOutput('arbiter', 'REVISE\n지적된 구현을 반영해라.'),
      ]),
    ).toBe('file-edit');
  });

  it('restores the retry action from a host evidence rejection', () => {
    const rejectedOutput = buildRejectedOwnerOutput({
      outputText: 'TASK_DONE\n상태: 구현 완료',
      reason: 'No worktree change.',
      retryAction: 'file-edit',
    });

    expect(
      resolveOwnerRequiredAction([makeOutput('owner', rejectedOutput)]),
    ).toBe('file-edit');
  });

  it('does not force another action after reviewer approval', () => {
    expect(
      resolveOwnerRequiredAction([
        makeOutput('reviewer', 'TASK_DONE\n코드 정확성 승인.'),
      ]),
    ).toBe('unspecified');
  });
});

describe('assessOwnerCompletionEvidence', () => {
  it('rejects a required file-edit turn without a new worktree change', () => {
    const repoDir = createRepo();
    const baseline = resolveCanonicalSourceRef(repoDir);

    expect(
      assessOwnerCompletionEvidence({
        workDir: repoDir,
        turnSourceRef: baseline,
        taskSourceRef: baseline,
        requiredAction: 'file-edit',
        outputText: 'TASK_DONE\n상태: 검증 완료',
      }),
    ).toMatchObject({
      accepted: false,
      hasChangesThisTurn: false,
      retryAction: 'file-edit',
    });
  });

  it('accepts a required file-edit turn after a real worktree change', () => {
    const repoDir = createRepo();
    const baseline = resolveCanonicalSourceRef(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'changed\n');

    expect(
      assessOwnerCompletionEvidence({
        workDir: repoDir,
        turnSourceRef: baseline,
        taskSourceRef: baseline,
        requiredAction: 'file-edit',
        outputText: 'TASK_DONE\n상태: 구현 완료',
      }),
    ).toMatchObject({
      accepted: true,
      hasChangesThisTurn: true,
      hasTaskChanges: true,
    });
  });

  it('does not let an earlier task change satisfy a later file-edit turn', () => {
    const repoDir = createRepo();
    const taskBaseline = resolveCanonicalSourceRef(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'earlier change\n');
    const turnBaseline = resolveCanonicalSourceRef(repoDir);

    expect(
      assessOwnerCompletionEvidence({
        workDir: repoDir,
        turnSourceRef: turnBaseline,
        taskSourceRef: taskBaseline,
        requiredAction: 'file-edit',
        outputText: 'TASK_DONE\n상태: 구현 완료',
      }),
    ).toMatchObject({
      accepted: false,
      hasChangesThisTurn: false,
      hasTaskChanges: true,
      retryAction: 'file-edit',
    });
  });

  it('rejects a change-complete report when the task worktree is unchanged', () => {
    const repoDir = createRepo();
    const baseline = resolveCanonicalSourceRef(repoDir);

    expect(
      assessOwnerCompletionEvidence({
        workDir: repoDir,
        turnSourceRef: baseline,
        taskSourceRef: baseline,
        requiredAction: 'unspecified',
        outputText: 'TASK_DONE\n상태: 구현 완료',
      }),
    ).toMatchObject({
      accepted: false,
      hasTaskChanges: false,
      retryAction: 'explain',
    });
  });

  it('rejects a no-change report when the task worktree changed', () => {
    const repoDir = createRepo();
    const baseline = resolveCanonicalSourceRef(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'changed\n');

    expect(
      assessOwnerCompletionEvidence({
        workDir: repoDir,
        turnSourceRef: baseline,
        taskSourceRef: baseline,
        requiredAction: 'unspecified',
        outputText: 'TASK_DONE\n상태: 파일은 수정하지 않았다.',
      }),
    ).toMatchObject({
      accepted: false,
      hasTaskChanges: true,
      retryAction: 'explain',
    });
  });

  it('rejects an internally contradictory change report', () => {
    const repoDir = createRepo();
    const baseline = resolveCanonicalSourceRef(repoDir);

    expect(
      assessOwnerCompletionEvidence({
        workDir: repoDir,
        turnSourceRef: baseline,
        taskSourceRef: baseline,
        requiredAction: 'unspecified',
        outputText: 'TASK_DONE\n상태: 구현 완료\n다만 파일은 수정하지 않았다.',
      }),
    ).toMatchObject({
      accepted: false,
      retryAction: 'explain',
    });
  });

  it('allows BLOCKED and NEEDS_CONTEXT without file-edit evidence', () => {
    const repoDir = createRepo();
    const baseline = resolveCanonicalSourceRef(repoDir);

    for (const outputText of [
      'BLOCKED\n외부 권한이 필요하다.',
      'NEEDS_CONTEXT\n사용자 결정이 필요하다.',
    ]) {
      expect(
        assessOwnerCompletionEvidence({
          workDir: repoDir,
          turnSourceRef: baseline,
          taskSourceRef: baseline,
          requiredAction: 'file-edit',
          outputText,
        }).accepted,
      ).toBe(true);
    }
  });
});
