import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from './agent-protocol.js';
import { runSpawnedAgentProcess } from './agent-runner-process.js';
import type { AgentInput, AgentOutput } from './agent-runner.js';
import type { RegisteredGroup } from './types.js';

function buildProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

function timed<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('agent process did not resolve')), 100),
    ),
  ]);
}

const group: RegisteredGroup = {
  name: 'Agent Runner Test',
  folder: 'agent-runner-test',
  trigger: '@Agent',
  added_at: '2026-01-01T00:00:00.000Z',
  agentType: 'codex',
};

const input: AgentInput = {
  prompt: 'run',
  groupFolder: 'agent-runner-test',
  chatJid: 'dc:test',
  runId: 'run-1',
  isMain: false,
};

describe('runSpawnedAgentProcess', () => {
  let logsDir: string | null = null;

  afterEach(() => {
    if (logsDir) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      logsDir = null;
    }
  });

  it('resolves even when streamed output delivery rejects', async () => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-agent-runner-'));
    const proc = buildProcess();
    const onOutput = vi.fn<(_: AgentOutput) => Promise<void>>(async () => {
      throw new Error('delivery failed');
    });

    const resultPromise = runSpawnedAgentProcess({
      proc,
      group,
      input,
      processName: 'test-agent',
      logsDir,
      startTime: Date.now(),
      onOutput,
    });

    (proc.stdout as PassThrough).write(
      [
        OUTPUT_START_MARKER,
        JSON.stringify({ status: 'success', result: 'hello' }),
        OUTPUT_END_MARKER,
      ].join('\n'),
    );
    proc.emit('close', 0, null);

    await expect(timed(resultPromise)).resolves.toMatchObject({
      status: 'success',
      result: null,
    });
    expect(onOutput).toHaveBeenCalledOnce();
  });

  it('enforces hard wall-clock timeout even while activity resets idle timeout', async () => {
    vi.useFakeTimers();
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-agent-runner-'));
    const proc = buildProcess();
    const resultPromise = runSpawnedAgentProcess({
      proc,
      group,
      input,
      processName: 'test-agent',
      logsDir,
      startTime: Date.now(),
      onOutput: vi.fn(async () => undefined),
      activityTimeoutMs: 50,
      hardTurnTimeoutMs: 100,
      terminationGraceMs: 20,
    });

    for (let elapsed = 0; elapsed < 90; elapsed += 30) {
      await vi.advanceTimersByTimeAsync(30);
      (proc.stderr as PassThrough).write('Turn in progress\n');
    }
    await vi.advanceTimersByTimeAsync(10);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', null, 'SIGTERM');
    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: 'Agent hard turn timeout after 100ms',
    });
    vi.useRealTimers();
  });

  it('sends SIGKILL after grace when SIGTERM was sent but the process did not close', async () => {
    vi.useFakeTimers();
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-agent-runner-'));
    const proc = buildProcess();
    void runSpawnedAgentProcess({
      proc,
      group,
      input,
      processName: 'test-agent',
      logsDir,
      startTime: Date.now(),
      activityTimeoutMs: 10,
      hardTurnTimeoutMs: 1_000,
      terminationGraceMs: 20,
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    proc.emit('close', null, 'SIGKILL');
    vi.useRealTimers();
  });
});
