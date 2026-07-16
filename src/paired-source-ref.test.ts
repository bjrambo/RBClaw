import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hasCodeChangesSinceRef,
  resolveCanonicalSourceRef,
} from './paired-source-ref.js';

describe('direct work directory source references', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createRepository(): string {
    const workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rbclaw-source-ref-'),
    );
    tempDirs.push(workDir);
    execFileSync('git', ['init', '--quiet'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'RBClaw Test'], {
      cwd: workDir,
    });
    execFileSync('git', ['config', 'user.email', 'rbclaw@example.test'], {
      cwd: workDir,
    });
    fs.writeFileSync(path.join(workDir, 'tracked.txt'), 'initial\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'Initial commit'], {
      cwd: workDir,
    });
    return workDir;
  }

  it('detects tracked and untracked changes without a generated branch', () => {
    const workDir = createRepository();
    const sourceRef = resolveCanonicalSourceRef(workDir);

    expect(sourceRef).toMatch(/^workdir-v1:[a-f0-9]{64}$/);
    expect(hasCodeChangesSinceRef(workDir, sourceRef)).toBe(false);

    fs.writeFileSync(path.join(workDir, 'tracked.txt'), 'changed\n');
    expect(hasCodeChangesSinceRef(workDir, sourceRef)).toBe(true);

    execFileSync('git', ['checkout', '--', 'tracked.txt'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'untracked.txt'), 'new\n');
    expect(hasCodeChangesSinceRef(workDir, sourceRef)).toBe(true);
  });

  it('falls back safely outside a Git repository', () => {
    const workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rbclaw-source-ref-'),
    );
    tempDirs.push(workDir);

    expect(resolveCanonicalSourceRef(workDir)).toBe('HEAD');
    expect(hasCodeChangesSinceRef(workDir, 'HEAD')).toBe(null);
  });
});
