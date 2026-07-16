import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RBCLAW_ENV } from 'rbclaw-runners-shared';

const {
  mockReadEnvFile,
  mockGetActiveCodexAuthPath,
  mockGetCodexAccountCount,
  mockClaimCodexAuthLease,
  mockFindCodexAccountIndexByAuthPath,
  mockReadCustomPrompt,
} = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn<() => Record<string, string>>(),
  mockGetActiveCodexAuthPath: vi.fn<() => string | null>(),
  mockGetCodexAccountCount: vi.fn<() => number>(),
  mockClaimCodexAuthLease: vi.fn<
    () => {
      authPath: string;
      accountIndex: number;
      release: () => void;
    } | null
  >(),
  mockFindCodexAccountIndexByAuthPath: vi.fn<() => number | null>(),
  mockReadCustomPrompt: vi.fn<() => string | undefined>(),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  GROUPS_DIR: '/tmp/rbclaw-test-groups',
  IS_TEST_ENV: true,
  LOG_LEVEL: 'info',
  SERVICE_ID: 'codex-main',
  SERVICE_SESSION_SCOPE: 'codex-main',
  TIMEZONE: 'Asia/Seoul',
  isReviewService: vi.fn(() => false),
}));

vi.mock('./env.js', () => ({
  readEnvFile: mockReadEnvFile,
  getEnv: vi.fn((_key: string) => undefined),
}));

vi.mock('./codex-token-rotation.js', () => ({
  getActiveCodexAuthPath: mockGetActiveCodexAuthPath,
  getCodexAccountCount: mockGetCodexAccountCount,
  claimCodexAuthLease: mockClaimCodexAuthLease,
  findCodexAccountIndexByAuthPath: mockFindCodexAccountIndexByAuthPath,
}));

vi.mock('./token-rotation.js', () => ({
  getCurrentToken: vi.fn(() => undefined),
  getConfiguredClaudeTokens: vi.fn(
    (options?: { multi?: string | undefined; single?: string | undefined }) => {
      if (options?.multi) {
        return options.multi
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean);
      }
      return options?.single ? [options.single] : [];
    },
  ),
}));

vi.mock('./platform-prompts.js', () => ({
  readCustomPrompt: mockReadCustomPrompt,
  readPlatformPrompt: vi.fn(() => 'platform prompt'),
  readPairedRoomPrompt: vi.fn(() => 'paired room prompt'),
  readArbiterPrompt: vi.fn(() => 'arbiter prompt'),
}));

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
  getEffectiveChannelLease: vi.fn(() => ({
    chat_jid: 'dc:test',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    arbiter_service_id: null,
    owner_failover_active: false,
    activated_at: null,
    reason: null,
    explicit: false,
  })),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/ipc/${folder}`,
  resolveServiceGroupSessionsPath: (folder: string, serviceId: string) =>
    `${process.env.EJ_TEST_ROOT}/sessions/${folder}/services/${serviceId}`,
  resolveTaskRuntimeIpcPath: (folder: string, taskId: string) =>
    `${process.env.EJ_TEST_ROOT}/task-ipc/${folder}/${taskId}`,
  resolveServiceTaskSessionsPath: (
    folder: string,
    serviceId: string,
    taskId: string,
  ) =>
    `${process.env.EJ_TEST_ROOT}/task-sessions/${folder}/${serviceId}/${taskId}`,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => process.env.EJ_TEST_HOME || '/tmp',
    },
    homedir: () => process.env.EJ_TEST_HOME || '/tmp',
  };
});

import {
  prepareReadonlySessionEnvironment,
  prepareGroupEnvironment,
} from './agent-runner-environment.js';
import * as config from './config.js';
import * as serviceRouting from './service-routing.js';
import type { RegisteredGroup } from './types.js';

beforeEach(() => {
  mockReadCustomPrompt.mockReset();
  mockReadCustomPrompt.mockReturnValue(undefined);
});

const group: RegisteredGroup = {
  name: 'Codex Test Group',
  folder: 'codex-test-group',
  trigger: '@Codex',
  added_at: new Date().toISOString(),
  agentType: 'codex',
};

function writeSkill(dir: string, name: string, marker = `${name} skill`): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${marker}\n---\n`,
  );
}

function resetRoutingMocks(): void {
  vi.mocked(config.isReviewService).mockReturnValue(false);
  vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
  vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
    chat_jid: 'dc:test',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    arbiter_service_id: null,
    owner_failover_active: false,
    activated_at: null,
    reason: null,
    explicit: false,
  });
}

describe('prepareGroupEnvironment codex auth handling', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousOpenAiKey: string | undefined;
  let previousCodexOpenAiKey: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'rbclaw-agent-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousCodexOpenAiKey = process.env.CODEX_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_OPENAI_API_KEY;

    fs.mkdirSync(process.env.EJ_TEST_HOME, { recursive: true });
    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    mockGetCodexAccountCount.mockReset();
    mockGetCodexAccountCount.mockReturnValue(0);
    mockClaimCodexAuthLease.mockReset();
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockFindCodexAccountIndexByAuthPath.mockReset();
    mockFindCodexAccountIndexByAuthPath.mockReturnValue(null);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    if (previousOpenAiKey) process.env.OPENAI_API_KEY = previousOpenAiKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousCodexOpenAiKey) {
      process.env.CODEX_OPENAI_API_KEY = previousCodexOpenAiKey;
    } else {
      delete process.env.CODEX_OPENAI_API_KEY;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('ignores OPENAI_API_KEY and always uses OAuth auth', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    const rotatedAuth = {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'x' },
    };
    fs.writeFileSync(rotatedAuthPath, JSON.stringify(rotatedAuth));
    mockGetActiveCodexAuthPath.mockReturnValue(rotatedAuthPath);
    mockReadEnvFile.mockReturnValue({
      OPENAI_API_KEY: 'sk-test-api-key',
      CODEX_MODEL: 'gpt-5.4',
    });

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      auth_mode: string;
      OPENAI_API_KEY?: string;
      tokens?: unknown;
    };

    // API key auth is never used — always OAuth
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(auth.tokens).toEqual({ access_token: 'x' });
  });

  it('falls back to rotated OAuth auth when no API key is configured', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    const rotatedAuth = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'oauth-access',
        refresh_token: 'oauth-refresh',
      },
    };
    fs.writeFileSync(rotatedAuthPath, JSON.stringify(rotatedAuth));
    mockGetActiveCodexAuthPath.mockReturnValue(rotatedAuthPath);
    mockReadEnvFile.mockReturnValue({});

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));

    expect(auth).toEqual(rotatedAuth);
  });

  it('fails fast instead of launching Codex without OAuth when rotation accounts exist but no lease is available', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    fs.writeFileSync(
      rotatedAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'locked-token' },
      }),
    );
    mockGetCodexAccountCount.mockReturnValue(1);
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockGetActiveCodexAuthPath.mockReturnValue(rotatedAuthPath);
    mockReadEnvFile.mockReturnValue({});

    expect(() => prepareGroupEnvironment(group, false, 'dc:test')).toThrow(
      /Codex rotation pool unavailable/,
    );

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'auth.json',
    );
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it('uses the leased canonical Codex home directly instead of copying pooled auth into a session home', () => {
    const canonicalCodexDir = path.join(tempRoot, 'codex-account-0');
    const canonicalAuthPath = path.join(canonicalCodexDir, 'auth.json');
    fs.mkdirSync(canonicalCodexDir, { recursive: true });
    fs.writeFileSync(
      canonicalAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'acct-0',
          access_token: 'canonical-access',
          refresh_token: 'canonical-refresh',
        },
      }),
    );
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'config.toml'),
      'model = "gpt-5.4"\n',
    );
    const release = vi.fn();
    mockGetCodexAccountCount.mockReturnValue(1);
    mockClaimCodexAuthLease.mockReturnValue({
      authPath: canonicalAuthPath,
      accountIndex: 0,
      release,
    });
    mockReadEnvFile.mockReturnValue({});

    const prepared = prepareGroupEnvironment(group, false, 'dc:test');

    const staleSessionAuthPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'auth.json',
    );
    expect(prepared.env.CODEX_HOME).toBe(canonicalCodexDir);
    expect(prepared.codexSessionAuth).toEqual(
      expect.objectContaining({
        canonicalAuthPath,
        sessionAuthPath: canonicalAuthPath,
        accountIndex: 0,
      }),
    );
    expect(fs.existsSync(staleSessionAuthPath)).toBe(false);
    expect(
      fs.readFileSync(path.join(canonicalCodexDir, 'config.toml'), 'utf-8'),
    ).toContain('model = "gpt-5.4"');
    expect(fs.existsSync(path.join(canonicalCodexDir, 'AGENTS.md'))).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a leased Codex slot when canonical CODEX_HOME preparation fails', () => {
    const canonicalCodexDir = path.join(tempRoot, 'codex-account-0');
    const canonicalAuthPath = path.join(canonicalCodexDir, 'auth.json');
    fs.mkdirSync(canonicalCodexDir, { recursive: true });
    fs.writeFileSync(
      canonicalAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { account_id: 'acct-0', access_token: 'canonical-access' },
      }),
    );
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'config.toml'),
      'model = "gpt-5.4"\n',
    );
    fs.mkdirSync(path.join(canonicalCodexDir, 'config.toml'));
    const release = vi.fn();
    mockGetCodexAccountCount.mockReturnValue(1);
    mockClaimCodexAuthLease.mockReturnValue({
      authPath: canonicalAuthPath,
      accountIndex: 0,
      release,
    });
    mockReadEnvFile.mockReturnValue({});

    expect(() => prepareGroupEnvironment(group, false, 'dc:test')).toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('prepareGroupEnvironment prompt stacks', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousOpenAiKey: string | undefined;
  let previousCodexOpenAiKey: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'rbclaw-agent-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousCodexOpenAiKey = process.env.CODEX_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_OPENAI_API_KEY;

    fs.mkdirSync(process.env.EJ_TEST_HOME, { recursive: true });
    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    mockGetCodexAccountCount.mockReset();
    mockGetCodexAccountCount.mockReturnValue(0);
    mockClaimCodexAuthLease.mockReset();
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockFindCodexAccountIndexByAuthPath.mockReset();
    mockFindCodexAccountIndexByAuthPath.mockReturnValue(null);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    if (previousOpenAiKey) process.env.OPENAI_API_KEY = previousOpenAiKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousCodexOpenAiKey) {
      process.env.CODEX_OPENAI_API_KEY = previousCodexOpenAiKey;
    } else {
      delete process.env.CODEX_OPENAI_API_KEY;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses the failover owner prompt pack for codex-review when it owns an explicit failover lease', () => {
    vi.mocked(config.isReviewService).mockReturnValue(true);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'codex-review',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      owner_failover_active: true,
      activated_at: '2026-03-28T00:00:00.000Z',
      reason: 'claude-429',
      explicit: true,
    });
    mockReadEnvFile.mockReturnValue({});
    mockReadCustomPrompt.mockReturnValue('local custom prompt');

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'codex-review-platform.md'),
      'review platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-platform.md'),
      'owner common platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'owner common paired prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'codex-review-failover-platform.md'),
      'failover platform prompt\n',
    );
    prepareGroupEnvironment(
      { ...group, workDir: path.join(tempRoot, 'workdir') },
      false,
      'dc:test',
      {
        memoryBriefing: 'memory briefing',
      },
    );

    const agentsPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'AGENTS.md',
    );
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    const segments = agents.trim().split('\n\n---\n\n');

    expect(segments).toEqual([
      'local custom prompt',
      'owner common platform prompt',
      'failover platform prompt',
      'owner common paired prompt',
      'memory briefing',
    ]);
  });

  it('adds only the shared owner prompt fragments to Claude session prompts', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadEnvFile.mockReturnValue({});

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-platform.md'),
      'owner common platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'owner common paired prompt\n',
    );

    prepareGroupEnvironment(
      { ...group, agentType: 'claude-code' },
      false,
      'dc:test',
      {
        memoryBriefing: 'memory briefing',
      },
    );

    const claudePath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.claude',
      'CLAUDE.md',
    );
    const claude = fs.readFileSync(claudePath, 'utf-8');
    const segments = claude.trim().split('\n\n---\n\n');

    expect(segments).toEqual([
      'owner common platform prompt',
      'platform prompt',
      'owner common paired prompt',
      'memory briefing',
    ]);
  });

  it('places the local custom prompt first in owner session prompts', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadEnvFile.mockReturnValue({});
    mockReadCustomPrompt.mockReturnValue('local custom prompt');

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-platform.md'),
      'owner common platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'owner common paired prompt\n',
    );

    prepareGroupEnvironment(
      { ...group, agentType: 'claude-code' },
      false,
      'dc:test',
    );

    const claudePath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.claude',
      'CLAUDE.md',
    );
    const segments = fs
      .readFileSync(claudePath, 'utf-8')
      .trim()
      .split('\n\n---\n\n');

    expect(segments[0]).toBe('local custom prompt');
    expect(
      segments.filter((part) => part === 'local custom prompt'),
    ).toHaveLength(1);
  });

  it('maps the canonical multi-token env to a single runner OAuth token', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadEnvFile.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKENS: 'token-a, token-b',
    });

    const prepared = prepareGroupEnvironment(
      { ...group, agentType: 'claude-code' },
      false,
      'dc:test',
    );

    expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-a');
  });

  it('can force Claude-compatible rooms to use ANTHROPIC_API_KEY instead of OAuth', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadEnvFile.mockReturnValue({
      ANTHROPIC_API_KEY: 'anthropic-api-key',
      CLAUDE_CODE_OAUTH_TOKENS: 'token-a, token-b',
    });

    const prepared = prepareGroupEnvironment(
      {
        ...group,
        agentType: 'claude-code',
        agentConfig: {
          claudeAuthMode: 'api',
          claudeModel: 'claude-fable-5',
        },
      },
      false,
      'dc:test',
    );

    expect(prepared.env.ANTHROPIC_API_KEY).toBe('anthropic-api-key');
    expect(prepared.env.CLAUDE_MODEL).toBe('claude-fable-5');
    expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(prepared.env.CLAUDE_CODE_OAUTH_TOKENS).toBeUndefined();
  });

  it('returns to the normal owner prompt stack after failover is cleared', () => {
    vi.mocked(config.isReviewService).mockReturnValue(true);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: null,
      owner_failover_active: false,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    mockReadEnvFile.mockReturnValue({});
    mockReadCustomPrompt.mockReturnValue('local custom prompt');

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    prepareGroupEnvironment(group, false, 'dc:test');

    const agentsPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'AGENTS.md',
    );
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    const segments = agents.trim().split('\n\n---\n\n');

    expect(segments).toEqual(['local custom prompt', 'platform prompt']);
  });
});

describe('prepareGroupEnvironment Codex MCP room role env', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'rbclaw-agent-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    fs.mkdirSync(process.env.EJ_TEST_HOME, { recursive: true });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    mockGetCodexAccountCount.mockReset();
    mockGetCodexAccountCount.mockReturnValue(0);
    mockClaimCodexAuthLease.mockReset();
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockFindCodexAccountIndexByAuthPath.mockReset();
    mockFindCodexAccountIndexByAuthPath.mockReturnValue(null);
    resetRoutingMocks();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeMcpServer(): void {
    const mcpServerPath = path.join(
      tempRoot,
      'runners',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    fs.mkdirSync(path.dirname(mcpServerPath), { recursive: true });
    fs.writeFileSync(mcpServerPath, '// test mcp server\n');
  }

  function readCodexConfigToml(): string {
    return fs.readFileSync(
      path.join(
        tempRoot,
        'sessions',
        group.folder,
        'services',
        'codex-main',
        '.codex',
        'config.toml',
      ),
      'utf-8',
    );
  }

  it('writes paired owner role into the Codex MCP config env', () => {
    mockReadEnvFile.mockReturnValue({});
    writeMcpServer();

    prepareGroupEnvironment(group, false, 'dc:test', {
      roomRole: 'owner',
    });

    expect(readCodexConfigToml()).toContain(`${RBCLAW_ENV.roomRole} = "owner"`);
  });

  it('omits room role from non-paired Codex MCP config env', () => {
    mockReadEnvFile.mockReturnValue({});
    writeMcpServer();

    prepareGroupEnvironment(group, true, 'dc:test');

    expect(readCodexConfigToml()).not.toContain(RBCLAW_ENV.roomRole);
  });
});

describe('prepareGroupEnvironment room skill overrides', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'rbclaw-agent-skills-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);
    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });
    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    mockGetCodexAccountCount.mockReset();
    mockGetCodexAccountCount.mockReturnValue(0);
    mockClaimCodexAuthLease.mockReset();
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockFindCodexAccountIndexByAuthPath.mockReset();
    mockFindCodexAccountIndexByAuthPath.mockReturnValue(null);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('filters Claude session skills with room overrides at spawn time', () => {
    mockReadEnvFile.mockReturnValue({});
    const homeSkills = path.join(
      process.env.EJ_TEST_HOME!,
      '.claude',
      'skills',
    );
    const workDir = path.join(tempRoot, 'workdir');
    const runnerSkills = path.join(tempRoot, 'runners', 'skills');
    const localSkills = path.join(tempRoot, 'runners', 'local-skills');
    writeSkill(homeSkills, 'claude-keep');
    writeSkill(path.join(workDir, '.claude', 'skills'), 'workdir-keep');
    writeSkill(runnerSkills, 'runner-keep');
    writeSkill(runnerSkills, 'runner-off');
    writeSkill(localSkills, 'runner-keep', 'local owner override');

    prepareGroupEnvironment(
      { ...group, agentType: 'claude-code', workDir },
      false,
      'dc:test',
      {
        skillOverrides: [
          {
            chatJid: 'dc:test',
            agentType: 'claude-code',
            skillScope: 'runner',
            skillName: 'runner-off',
            enabled: false,
            createdAt: '2026-05-04T00:00:00.000Z',
            updatedAt: '2026-05-04T00:00:00.000Z',
          },
        ],
      },
    );

    const sessionSkills = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.claude',
      'skills',
    );
    expect(fs.existsSync(path.join(sessionSkills, 'claude-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'workdir-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-keep'))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(sessionSkills, 'runner-keep', 'SKILL.md'),
        'utf-8',
      ),
    ).toContain('local owner override');
    expect(fs.existsSync(path.join(sessionSkills, 'runner-off'))).toBe(false);
  });

  it('uses a session-scoped Codex home when room overrides disable skills', () => {
    mockReadEnvFile.mockReturnValue({});
    const codexSkills = path.join(
      process.env.EJ_TEST_HOME!,
      '.agents',
      'skills',
    );
    const runnerSkills = path.join(tempRoot, 'runners', 'skills');
    const localSkills = path.join(tempRoot, 'runners', 'local-skills');
    writeSkill(codexSkills, 'codex-keep');
    writeSkill(codexSkills, 'codex-off');
    writeSkill(runnerSkills, 'runner-keep');
    writeSkill(runnerSkills, 'runner-off');
    writeSkill(localSkills, 'runner-keep', 'local owner override');

    const prepared = prepareGroupEnvironment(group, false, 'dc:test', {
      skillOverrides: [
        {
          chatJid: 'dc:test',
          agentType: 'codex',
          skillScope: 'codex-user',
          skillName: 'codex-off',
          enabled: false,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
        {
          chatJid: 'dc:test',
          agentType: 'codex',
          skillScope: 'runner',
          skillName: 'runner-off',
          enabled: false,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
      ],
    });

    const sessionRoot = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
    );
    const sessionHome = path.join(sessionRoot, 'home');
    const sessionSkills = path.join(sessionHome, '.agents', 'skills');
    expect(prepared.env.HOME).toBe(sessionHome);
    expect(prepared.env.CODEX_HOME).toBe(path.join(sessionRoot, '.codex'));
    expect(fs.existsSync(path.join(sessionSkills, 'codex-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-keep'))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(sessionSkills, 'runner-keep', 'SKILL.md'),
        'utf-8',
      ),
    ).toContain('local owner override');
    expect(fs.existsSync(path.join(sessionSkills, 'codex-off'))).toBe(false);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-off'))).toBe(false);
    expect(fs.existsSync(path.join(codexSkills, 'codex-off'))).toBe(true);
  });
});

describe('prepareGroupEnvironment Codex goals handling', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousCodexGoals: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'rbclaw-agent-env-goals-'));
    previousCwd = process.cwd();
    previousCodexGoals = process.env.CODEX_GOALS;
    process.chdir(tempRoot);
    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    delete process.env.CODEX_GOALS;

    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    mockGetCodexAccountCount.mockReset();
    mockGetCodexAccountCount.mockReturnValue(0);
    mockClaimCodexAuthLease.mockReset();
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockFindCodexAccountIndexByAuthPath.mockReset();
    mockFindCodexAccountIndexByAuthPath.mockReturnValue(null);
    vi.mocked(config.isReviewService).mockReturnValue(false);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: null,
      owner_failover_active: false,
      activated_at: null,
      reason: null,
      explicit: false,
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    if (previousCodexGoals) process.env.CODEX_GOALS = previousCodexGoals;
    else delete process.env.CODEX_GOALS;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps Codex goals disabled by default and enables them only via opt-in config', () => {
    mockReadEnvFile.mockReturnValue({});

    const defaultPrepared = prepareGroupEnvironment(group, false, 'dc:test');
    expect(defaultPrepared.env.CODEX_GOALS).toBeUndefined();

    const enabledPrepared = prepareGroupEnvironment(
      {
        ...group,
        agentConfig: {
          codexGoals: true,
        },
      },
      false,
      'dc:test',
    );
    expect(enabledPrepared.env.CODEX_GOALS).toBe('true');
  });

  it('allows CODEX_GOALS env opt-in for Codex runner sessions', () => {
    mockReadEnvFile.mockReturnValue({
      CODEX_GOALS: 'true',
    });

    const prepared = prepareGroupEnvironment(group, false, 'dc:test');

    expect(prepared.env.CODEX_GOALS).toBe('true');
  });

  it('enables goals from host ~/.codex/config.toml [features]', () => {
    mockReadEnvFile.mockReturnValue({});
    const homedirSpy = vi
      .spyOn(os, 'homedir')
      .mockReturnValue(process.env.EJ_TEST_HOME!);
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'config.toml'),
      '[features]\ngoals = true\n',
    );

    try {
      const prepared = prepareGroupEnvironment(group, false, 'dc:test');
      expect(prepared.env.CODEX_GOALS).toBe('true');
    } finally {
      homedirSpy.mockRestore();
    }
  });
});

describe('prepareReadonlySessionEnvironment codex compatibility', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'rbclaw-readonly-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');

    fs.mkdirSync(process.env.EJ_TEST_HOME, { recursive: true });
    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    mockGetCodexAccountCount.mockReset();
    mockGetCodexAccountCount.mockReturnValue(0);
    mockClaimCodexAuthLease.mockReset();
    mockClaimCodexAuthLease.mockReturnValue(null);
    mockFindCodexAccountIndexByAuthPath.mockReset();
    mockFindCodexAccountIndexByAuthPath.mockReturnValue(null);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not claim a Codex auth lease for Claude read-only sessions', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadCustomPrompt.mockReturnValue('local custom prompt');
    mockGetCodexAccountCount.mockReturnValue(1);
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    fs.writeFileSync(rotatedAuthPath, '{"auth_mode":"chatgpt"}\n');
    const release = vi.fn();
    mockClaimCodexAuthLease.mockReturnValue({
      authPath: rotatedAuthPath,
      accountIndex: 0,
      release,
    });

    const sessionDir = path.join(tempRoot, 'readonly-claude-session');
    const workDir = path.join(tempRoot, 'project');
    const prepared = prepareReadonlySessionEnvironment({
      sessionDir,
      chatJid: 'dc:test',
      isMain: false,
      groupFolder: 'codex-test-group',
      agentType: 'claude-code',
      memoryBriefing: 'memory briefing',
      role: 'reviewer',
      workDir,
    });

    expect(prepared.codexSessionAuth).toBeNull();
    expect(mockClaimCodexAuthLease).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir, '.codex', 'auth.json'))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(sessionDir, 'CLAUDE.md'), 'utf-8'),
    ).not.toContain('local custom prompt');
  });

  it('keeps local runner skill overrides out of read-only sessions', () => {
    const runnerSkills = path.join(tempRoot, 'runners', 'skills');
    const localSkills = path.join(tempRoot, 'runners', 'local-skills');
    writeSkill(runnerSkills, 'shared-skill', 'public runner skill');
    writeSkill(localSkills, 'shared-skill', 'private owner override');

    const sessionDir = path.join(tempRoot, 'readonly-public-skills');
    prepareReadonlySessionEnvironment({
      sessionDir,
      chatJid: 'dc:test',
      isMain: false,
      groupFolder: 'codex-test-group',
      agentType: 'claude-code',
      role: 'reviewer',
      workDir: path.join(tempRoot, 'project'),
    });

    const skill = fs.readFileSync(
      path.join(sessionDir, 'skills', 'shared-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(skill).toContain('public runner skill');
    expect(skill).not.toContain('private owner override');
  });

  it('writes matching AGENTS.md and copies host codex auth/config into the role-scoped session', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    const mcpServerPath = path.join(
      tempRoot,
      'runners',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    fs.mkdirSync(path.dirname(mcpServerPath), { recursive: true });
    fs.writeFileSync(mcpServerPath, '// test mcp server\n');
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'auth.json'),
      '{"auth_mode":"chatgpt"}\n',
    );
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'config.toml'),
      `model = "gpt-5.4"

[mcp_servers.rbclaw]
command = "node"
args = ["old-ipc.js"]

[mcp_servers.rbclaw.env]
${RBCLAW_ENV.ipcDir} = "/old/ipc"

[mcp_servers.other]
command = "node"
args = ["other.js"]
`,
    );

    const sessionDir = path.join(tempRoot, 'readonly-reviewer-session');
    const workDir = path.join(tempRoot, 'project');
    prepareReadonlySessionEnvironment({
      sessionDir,
      chatJid: 'dc:test',
      isMain: false,
      groupFolder: 'codex-test-group',
      agentType: 'codex',
      memoryBriefing: 'memory briefing',
      role: 'reviewer',
      workDir,
    });

    const claudeMd = fs.readFileSync(
      path.join(sessionDir, 'CLAUDE.md'),
      'utf-8',
    );
    expect(
      fs.readFileSync(path.join(sessionDir, '.codex', 'AGENTS.md'), 'utf-8'),
    ).toBe(claudeMd);
    expect(
      fs.readFileSync(path.join(sessionDir, '.codex', 'auth.json'), 'utf-8'),
    ).toContain('"auth_mode":"chatgpt"');
    expect(
      fs.readFileSync(path.join(sessionDir, '.claude.json'), 'utf-8'),
    ).toBe('{}\n');
    const toml = fs.readFileSync(
      path.join(sessionDir, '.codex', 'config.toml'),
      'utf-8',
    );
    expect(toml).toContain('model = "gpt-5.4"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain('[mcp_servers.rbclaw]');
    expect(toml).toContain(`${RBCLAW_ENV.ipcDir} = "/workspace/ipc"`);
    expect(toml).toContain(`${RBCLAW_ENV.groupFolder} = "codex-test-group"`);
    expect(toml).toContain(`${RBCLAW_ENV.roomRole} = "reviewer"`);
    expect(toml).toContain(`${RBCLAW_ENV.workDir} = "${workDir}"`);
    expect(toml).not.toContain('old-ipc.js');
    expect(toml).not.toContain('"/old/ipc"');
    expect(toml.match(/\[mcp_servers\.rbclaw\]/g)).toHaveLength(1);
    expect(toml.match(/\[mcp_servers\.rbclaw\.env\]/g)).toHaveLength(1);
  });
});
