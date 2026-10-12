import { execFileSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveBundledClaudeCodeExecutable } from '../src/bundled-cli-path.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sdkPackage = '@anthropic-ai/claude-agent-sdk';

function atLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== required[index]) {
      return actual[index] > required[index];
    }
  }
  return true;
}

describe('Opus 5.5 bundled runtime compatibility', () => {
  it('pins and installs an SDK with matching native runtime dependencies', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, 'runners/agent-runner/package.json'),
        'utf8',
      ),
    );
    const declared = manifest.dependencies[sdkPackage];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(declared, '0.3.280')).toBe(true);

    const require = createRequire(import.meta.url);
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(require.resolve(sdkPackage)), 'package.json'),
        'utf8',
      ),
    );
    expect(installed.version).toBe(declared);

    const lock = ts.parseConfigFileTextToJson(
      'bun.lock',
      fs.readFileSync(path.join(projectRoot, 'bun.lock'), 'utf8'),
    );
    expect(lock.error).toBeUndefined();
    expect(
      lock.config.workspaces['runners/agent-runner'].dependencies[sdkPackage],
    ).toBe(declared);
    expect(lock.config.packages[sdkPackage][0]).toBe(
      `${sdkPackage}@${declared}`,
    );
    for (const [name, version] of Object.entries(
      installed.optionalDependencies,
    )) {
      expect(version).toBe(declared);
      expect(lock.config.packages[name][0]).toBe(`${name}@${declared}`);
    }
  });

  it('runs only the bundled CLI version check and requires Claude Code 2.1.280', () => {
    const cli = resolveBundledClaudeCodeExecutable({ env: {} });
    expect(
      cli.startsWith(path.join(projectRoot, 'node_modules') + path.sep),
    ).toBe(true);
    const output = execFileSync(cli, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: projectRoot,
        SystemRoot: process.env.SystemRoot,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
    }).trim();
    const version = output.match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
    expect(version).not.toBeNull();
    expect(atLeast(version![1], '2.1.280')).toBe(true);
  });
});
