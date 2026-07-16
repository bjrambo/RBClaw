import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const sandboxScript = path.join(
  process.cwd(),
  'scripts/run-agent-filesystem-sandbox.sh',
);

function runSandbox(
  accessMode: 'ro' | 'rw',
  workDir: string,
  command: string,
  writablePaths: string[] = [],
  commandArgs: string[] = [],
) {
  const protectedRoot = os.homedir();
  return spawnSync(
    '/usr/bin/unshare',
    [
      '--user',
      '--map-current-user',
      '--keep-caps',
      '--mount',
      '--fork',
      '--kill-child',
      sandboxScript,
      accessMode,
      workDir,
      protectedRoot,
      ...writablePaths.flatMap((writablePath) => ['--writable', writablePath]),
      '--',
      'bash',
      '-ceu',
      command,
      'sandbox-test',
      workDir,
      protectedRoot,
      ...commandArgs,
    ],
    { encoding: 'utf-8' },
  );
}

function canRunSandbox(): boolean {
  if (!fs.existsSync('/usr/bin/unshare') || !fs.existsSync(sandboxScript)) {
    return false;
  }
  const probeDir = fs.mkdtempSync(
    path.join(process.cwd(), 'data/.sandbox-probe-'),
  );
  try {
    return runSandbox('ro', probeDir, 'test -d "$1"').status === 0;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRunSandbox())('agent filesystem sandbox', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeWorkDir(): string {
    const workDir = fs.mkdtempSync(
      path.join(process.cwd(), 'data/.sandbox-test-'),
    );
    tempDirs.push(workDir);
    fs.writeFileSync(path.join(workDir, 'input.txt'), 'readable\n');
    return workDir;
  }

  it('allows reads and denies writes in reviewer mode', () => {
    const workDir = makeWorkDir();
    const result = runSandbox(
      'ro',
      workDir,
      'cat "$1/input.txt" >/dev/null; if printf blocked > "$1/blocked.txt"; then exit 1; fi',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(workDir, 'blocked.txt'))).toBe(false);
  });

  it('preserves the caller uid and drops namespace capabilities', () => {
    const workDir = makeWorkDir();
    const expectedUid = String(process.getuid?.() ?? os.userInfo().uid);
    const result = runSandbox(
      'ro',
      workDir,
      'test "$(id -u)" = "$3"; grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status',
      [],
      [expectedUid],
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('makes the protected host root read-only and drops remount capability', () => {
    const workDir = makeWorkDir();
    const outsideDir = fs.mkdtempSync(
      path.join(process.cwd(), 'data/.sandbox-outside-'),
    );
    tempDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'host.txt');
    fs.writeFileSync(outsideFile, 'unchanged\n');

    const result = runSandbox(
      'ro',
      workDir,
      'if printf blocked > "$3"; then exit 1; fi; if mount -o remount,rw,bind "$2" 2>/dev/null; then exit 2; fi',
      [],
      [outsideFile],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('unchanged\n');
  });

  it('keeps only explicit runtime paths writable', () => {
    const workDir = makeWorkDir();
    const runtimeDir = fs.mkdtempSync(
      path.join(process.cwd(), 'data/.sandbox-runtime-'),
    );
    tempDirs.push(runtimeDir);

    const result = runSandbox(
      'ro',
      workDir,
      'printf runtime > "$3/runtime.txt"',
      [runtimeDir],
      [runtimeDir],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(runtimeDir, 'runtime.txt'), 'utf-8')).toBe(
      'runtime',
    );
  });

  it('rejects writable runtime paths that overlap the work directory', () => {
    const workDir = makeWorkDir();
    const runtimeDir = path.join(workDir, 'runtime');
    fs.mkdirSync(runtimeDir);

    const result = runSandbox('ro', workDir, 'exit 0', [runtimeDir]);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain(
      'writable sandbox path overlaps read-only work directory',
    );
  });

  it('allows writes in owner mode', () => {
    const workDir = makeWorkDir();
    const result = runSandbox(
      'rw',
      workDir,
      'printf allowed > "$1/allowed.txt"',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(workDir, 'allowed.txt'), 'utf-8')).toBe(
      'allowed',
    );
  });
});
