import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireWorkDirExecutionLock } from './work-dir-execution-lock.js';

describe('acquireWorkDirExecutionLock', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-work-lock-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  it('serializes aliases that resolve to the same directory', async () => {
    const target = makeTempDir();
    const linkRoot = makeTempDir();
    const link = path.join(linkRoot, 'project');
    fs.symlinkSync(target, link, 'dir');

    const releaseFirst = await acquireWorkDirExecutionLock(target);
    let secondAcquired = false;
    const second = acquireWorkDirExecutionLock(link).then((release) => {
      secondAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it('does not block a different directory', async () => {
    const first = makeTempDir();
    const second = makeTempDir();

    const releaseFirst = await acquireWorkDirExecutionLock(first);
    const releaseSecond = await acquireWorkDirExecutionLock(second);

    releaseSecond();
    releaseFirst();
  });
});
