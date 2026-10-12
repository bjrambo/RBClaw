import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  options: undefined as Options | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* (args: { options: Options }) {
    fixture.options = args.options;
    yield { type: 'result', subtype: 'success', result: 'TASK_DONE' };
  }),
}));
vi.mock('../src/claude-cli.js', () => ({
  getClaudeCliPath: () => '/mock-only/bundled-claude',
}));
vi.mock('../src/ipc-input.js', () => ({
  drainIpcInput: () => [],
  shouldClose: () => false,
}));
vi.mock('../src/output-protocol.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/output-protocol.js')>()),
  writeOutput: vi.fn(),
}));

import { runClaudeQuery } from '../src/claude-query-runner.js';

beforeEach(() => {
  vi.useFakeTimers();
  fixture.options = undefined;
  vi.stubEnv('CLAUDE_MODEL', 'claude-opus-5-5');
  vi.stubEnv('CLAUDE_EFFORT', 'high');
  vi.stubEnv('CLAUDE_THINKING', 'adaptive');
  vi.stubEnv('RBCLAW_AGENT_TYPE', 'claude-code');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Claude paired-role SDK model options', () => {
  it.each(['reviewer', 'arbiter'] as const)(
    'passes Opus 5.5 and high effort to the %s SDK query without changing OAuth',
    async (role) => {
      const sdkEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token' };
      await runClaudeQuery({
        prompt: 'Synthetic model fixture; no provider calls',
        sessionId: undefined,
        mcpServerPath: '/mock-only/mcp',
        runnerInput: {
          prompt: 'Synthetic model fixture; no provider calls',
          chatJid: 'dc:fixture',
          groupFolder: 'fixture',
          isMain: false,
          roomRoleContext: {
            role,
            serviceId: 'claude',
            ownerServiceId: 'codex-main',
            reviewerServiceId: 'claude',
            arbiterServiceId: 'claude',
            failoverOwner: false,
          },
        },
        sdkEnv,
        reviewerRuntime: true,
        claudeReadonlyReviewerRuntime: true,
        claudeReadonlySandboxMode: 'strict',
        abortController: new AbortController(),
        paths: {
          workDir: process.cwd(),
          groupDir: process.cwd(),
          groupFolder: 'fixture',
          hostTasksDir: '/mock-only',
          ipcInputCloseSentinel: '/mock-only',
          ipcInputDir: '/mock-only',
        },
        log: vi.fn(),
      });

      expect(fixture.options).toMatchObject({
        pathToClaudeCodeExecutable: '/mock-only/bundled-claude',
        model: 'claude-opus-5-5',
        effort: 'high',
        thinking: { type: 'adaptive' },
        env: sdkEnv,
      });
      expect(fixture.options!.env).toBe(sdkEnv);
      expect(fixture.options!.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(fixture.options!.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(fixture.options!.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    },
  );
});
