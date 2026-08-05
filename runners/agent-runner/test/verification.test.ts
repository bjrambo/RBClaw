import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  computeVerificationSnapshotId,
  formatVerificationResponse,
  runVerificationRequestDirect,
} from '../src/verification.js';

function createExternalProject(scripts: Record<string, string>): string {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rbclaw-external-verification-'),
  );
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({
      name: 'external-verification-target',
      private: true,
      packageManager: 'bun@1.3.11',
      scripts,
    }),
  );
  fs.mkdirSync(path.join(repoDir, 'node_modules'));
  fs.writeFileSync(path.join(repoDir, 'node_modules', '.installed'), '');
  return repoDir;
}

describe('runner verification helpers', () => {
  it('computes the same snapshot when excluded files change', () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rbclaw-runner-snapshot-'),
    );
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const x = 1;\n',
    );
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');

    const first = computeVerificationSnapshotId(repoDir);
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=2\n');
    const second = computeVerificationSnapshotId(repoDir);

    expect(second).toBe(first);
  });

  it('formats the response into a compact MCP-friendly text block', () => {
    const text = formatVerificationResponse({
      requestId: 'req-2',
      ok: false,
      profile: 'build',
      command: 'npm run build',
      stdout: 'tsc output\n',
      stderr: 'build failed\n',
      exitCode: 1,
      snapshotId: 'fs:def456',
      runtimeVersion: 'host:bun@test',
      error: 'command failed',
    });

    expect(text).toContain('Verification profile: build');
    expect(text).toContain('Snapshot: fs:def456');
    expect(text).toContain('Runtime: host:bun@test');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('$ npm run build');
    expect(text).toContain('[stderr]');
    expect(text).toContain('[error] command failed');
  });

  it('runs verification against an external project without harness files', async () => {
    const repoDir = createExternalProject({
      lint: 'node -e "process.stdout.write(\'external lint ok\')"',
    });

    const response = await runVerificationRequestDirect(repoDir, {
      requestId: 'external-lint',
      profile: 'lint',
    });

    expect(response).toMatchObject({
      requestId: 'external-lint',
      ok: true,
      profile: 'lint',
      command: 'bun run lint',
      exitCode: 0,
    });
    expect(response.stdout).toContain('external lint ok');
    expect(
      fs.existsSync(
        path.join(repoDir, 'shared', 'verification-request-runner.js'),
      ),
    ).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'src', 'verification.ts'))).toBe(
      false,
    );
  });

  it('reports an unconfigured external verification profile', async () => {
    const repoDir = createExternalProject({});

    const response = await runVerificationRequestDirect(repoDir, {
      requestId: 'external-lint-missing',
      profile: 'lint',
    });

    expect(response).toMatchObject({
      requestId: 'external-lint-missing',
      ok: false,
      profile: 'lint',
      exitCode: 1,
      error:
        'Verification profile "lint" is not configured in package.json scripts.',
    });
  });
});
