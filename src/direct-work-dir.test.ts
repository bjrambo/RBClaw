import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { DirectWorkDirError, resolveDirectWorkDir } from './direct-work-dir.js';

describe('resolveDirectWorkDir', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-work-dir-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  it('returns the canonical path for an existing directory', () => {
    const target = makeTempDir();
    const linkRoot = makeTempDir();
    const link = path.join(linkRoot, 'project');
    fs.symlinkSync(target, link, 'dir');

    expect(resolveDirectWorkDir(link)).toBe(fs.realpathSync.native(target));
  });

  it('rejects missing, relative, and non-directory paths', () => {
    expect(() => resolveDirectWorkDir('relative/project')).toThrow(
      DirectWorkDirError,
    );
    expect(() => resolveDirectWorkDir('/tmp/rbclaw-missing-work-dir')).toThrow(
      /does not exist/,
    );

    const tempDir = makeTempDir();
    const filePath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(filePath, 'not a directory');
    expect(() => resolveDirectWorkDir(filePath)).toThrow(/not a directory/);
  });
});
