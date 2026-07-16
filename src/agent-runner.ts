import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { RBCLAW_ENV } from 'rbclaw-runners-shared';

/**
 * Agent Process Runner for RBClaw
 * Spawns owner execution on the host and read-only roles in a mount namespace.
 */
import {
  prepareReadonlySessionEnvironment,
  prepareGroupEnvironment,
  type PreparedCodexSessionAuth,
} from './agent-runner-environment.js';
import { syncCodexSessionAuthBack } from './codex-token-rotation.js';
import { runSpawnedAgentProcess } from './agent-runner-process.js';
import { getStoredRoomSkillOverrides } from './db.js';
import { DirectWorkDirError, resolveDirectWorkDir } from './direct-work-dir.js';
export {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner-snapshot.js';
import { logger } from './logger.js';
import { type AgentType, RegisteredGroup, RoomRoleContext } from './types.js';
import type { StoredRoomSkillOverride } from './db/rooms.js';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  memoryBriefing?: string;
  groupFolder: string;
  chatJid: string;
  runId?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  runtimeTaskId?: string;
  useTaskScopedSession?: boolean;
  assistantName?: string;
  agentType?: AgentType;
  codexGoals?: boolean;
  roomRoleContext?: RoomRoleContext;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  output?: import('./types.js').StructuredAgentOutput;
  phase?: import('./types.js').AgentOutputPhase;
  agentId?: string;
  agentLabel?: string;
  agentDone?: boolean;
  newSessionId?: string;
  error?: string;
  compaction?: {
    completed: boolean;
    trigger?: string | null;
  };
}

function readRoomSkillOverridesForRunner(
  chatJid: string,
): StoredRoomSkillOverride[] {
  try {
    return getStoredRoomSkillOverrides(chatJid);
  } catch (err) {
    logger.warn(
      {
        err,
        chatJid,
      },
      'Failed to read room skill overrides; falling back to default skills',
    );
    return [];
  }
}

function releaseCodexAuthSession(
  auth: PreparedCodexSessionAuth | null | undefined,
): void {
  auth?.lease?.release();
}

function finalizeCodexAuthSession(
  auth: PreparedCodexSessionAuth | null | undefined,
): void {
  if (!auth) return;
  try {
    syncCodexSessionAuthBack({
      canonicalAuthPath: auth.canonicalAuthPath,
      sessionAuthPath: auth.sessionAuthPath,
      accountIndex: auth.accountIndex,
    });
  } catch (err) {
    logger.warn(
      {
        err,
        canonicalAuthPath: auth.canonicalAuthPath,
        accountIndex: auth.accountIndex,
      },
      'Failed to sync Codex session auth back to canonical slot',
    );
  } finally {
    auth.lease?.release();
  }
}

function createCodexAuthSessionFinalizer(
  getAuth: () => PreparedCodexSessionAuth | null | undefined,
): () => void {
  let finalized = false;
  return () => {
    if (finalized) return;
    finalized = true;
    finalizeCodexAuthSession(getAuth());
  };
}

function errorAgentOutput(error: unknown): AgentOutput {
  return {
    status: 'error',
    result: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function prepareRuntimeEnvironment(args: {
  group: RegisteredGroup;
  input: AgentInput;
  env: Record<string, string>;
  envOverrides?: Record<string, string>;
  skillOverrides: StoredRoomSkillOverride[];
  codexSessionAuth?: PreparedCodexSessionAuth | null;
}): PreparedCodexSessionAuth | null | undefined {
  const { group, input, env, envOverrides, skillOverrides } = args;
  for (const [key, value] of Object.entries(envOverrides ?? {})) {
    if (value) env[key] = value;
  }

  const configuredWorkDir = env[RBCLAW_ENV.workDir];
  if (!configuredWorkDir) {
    throw new DirectWorkDirError(
      'Channel workDir is required; group-folder fallback is disabled.',
    );
  }
  env[RBCLAW_ENV.workDir] = resolveDirectWorkDir(configuredWorkDir);

  const role = input.roomRoleContext?.role;
  if (
    !envOverrides?.CLAUDE_CONFIG_DIR ||
    (role !== 'reviewer' && role !== 'arbiter')
  ) {
    if (input.runId) env[RBCLAW_ENV.runId] = input.runId;
    return args.codexSessionAuth;
  }

  const readonlySession = prepareReadonlySessionEnvironment({
    sessionDir: envOverrides.CLAUDE_CONFIG_DIR,
    chatJid: input.chatJid,
    isMain: input.isMain,
    groupFolder: group.folder,
    agentType: group.agentType || 'claude-code',
    memoryBriefing: input.memoryBriefing,
    role,
    ipcDir: env[RBCLAW_ENV.ipcDir],
    hostIpcDir: env[RBCLAW_ENV.hostIpcDir],
    workDir: env[RBCLAW_ENV.workDir],
    skillOverrides,
  });
  env.HOME = readonlySession.homeDir ?? envOverrides.CLAUDE_CONFIG_DIR;
  if (input.runId) env[RBCLAW_ENV.runId] = input.runId;
  if ((group.agentType || 'claude-code') !== 'codex') {
    return args.codexSessionAuth;
  }

  releaseCodexAuthSession(args.codexSessionAuth);
  env.CODEX_HOME =
    readonlySession.codexHomeDir ??
    path.join(envOverrides.CLAUDE_CONFIG_DIR, '.codex');
  return readonlySession.codexSessionAuth;
}

function buildAgentSpawnCommand(args: {
  input: AgentInput;
  env: Record<string, string>;
  distEntry: string;
}): { executable: string; executableArgs: string[] } {
  const readonlyRole =
    args.input.roomRoleContext?.role === 'reviewer' ||
    args.input.roomRoleContext?.role === 'arbiter';
  if (!readonlyRole) {
    return { executable: 'bun', executableArgs: [args.distEntry] };
  }

  const workDir = args.env[RBCLAW_ENV.workDir];
  if (!workDir) {
    throw new Error('Read-only role execution requires a channel workDir.');
  }
  const sandboxScript = path.join(
    process.cwd(),
    'scripts',
    'run-agent-filesystem-sandbox.sh',
  );
  if (!fs.existsSync('/usr/bin/unshare') || !fs.existsSync(sandboxScript)) {
    throw new Error(
      'Read-only filesystem sandbox is unavailable; refusing reviewer execution.',
    );
  }

  const writablePaths = [
    args.env.CLAUDE_CONFIG_DIR,
    args.env[RBCLAW_ENV.ipcDir],
    args.env[RBCLAW_ENV.hostIpcDir],
    args.env.CODEX_HOME,
  ].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
  return {
    executable: '/usr/bin/unshare',
    executableArgs: [
      '--user',
      '--map-current-user',
      '--keep-caps',
      '--mount',
      '--fork',
      '--kill-child',
      sandboxScript,
      'ro',
      workDir,
      os.homedir(),
      ...writablePaths.flatMap((writablePath) => ['--writable', writablePath]),
      '--',
      'bun',
      args.distEntry,
    ],
  };
}

export async function runAgentProcess(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (
    proc: ChildProcess,
    processName: string,
    runtimeIpcDir: string,
  ) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  envOverrides?: Record<string, string>,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const skillOverrides = readRoomSkillOverridesForRunner(input.chatJid);
  const prepared = prepareGroupEnvironment(group, input.isMain, input.chatJid, {
    memoryBriefing: input.memoryBriefing,
    runtimeTaskId: input.runtimeTaskId,
    useTaskScopedSession: input.useTaskScopedSession,
    skillOverrides,
    roomRole: input.roomRoleContext?.role,
  });
  const { env, groupDir, runnerDir } = prepared;
  let codexSessionAuth = prepared.codexSessionAuth;
  try {
    codexSessionAuth = prepareRuntimeEnvironment({
      group,
      input,
      env,
      envOverrides,
      skillOverrides,
      codexSessionAuth,
    });
  } catch (error) {
    releaseCodexAuthSession(codexSessionAuth);
    if (error instanceof DirectWorkDirError) {
      return errorAgentOutput(error);
    }
    throw error;
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processSuffix = input.runId || `${Date.now()}`;
  const processName = `rbclaw-${safeName}-${processSuffix}`;
  const finalizeCodexAuthSessionOnce = createCodexAuthSessionFinalizer(
    () => codexSessionAuth,
  );

  // Check if runner is built
  const distEntry = path.join(runnerDir, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    logger.error(
      { runnerDir, chatJid: input.chatJid, runId: input.runId },
      'Runner not built. Run: cd runners/agent-runner && bun install && bun run build',
    );
    releaseCodexAuthSession(codexSessionAuth);
    return {
      status: 'error',
      result: null,
      error: `Runner not built at ${distEntry}. Run bun run build:runners first.`,
    };
  }

  logger.info(
    {
      group: group.name,
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      runId: input.runId,
      processName,
      agentType: group.agentType || 'claude-code',
      isMain: input.isMain,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  let spawnCommand: ReturnType<typeof buildAgentSpawnCommand>;
  try {
    spawnCommand = buildAgentSpawnCommand({ input, env, distEntry });
  } catch (error) {
    releaseCodexAuthSession(codexSessionAuth);
    return errorAgentOutput(error);
  }

  return new Promise((resolve) => {
    const proc = spawn(spawnCommand.executable, spawnCommand.executableArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runnerDir,
      env,
    });

    onProcess(proc, processName, env[RBCLAW_ENV.ipcDir]);

    const runnerInput: AgentInput = {
      ...input,
      ...(group.agentConfig?.codexGoals === true ? { codexGoals: true } : {}),
    };
    proc.stdin.write(JSON.stringify(runnerInput));
    proc.stdin.end();

    runSpawnedAgentProcess({
      proc,
      group,
      input: runnerInput,
      processName,
      logsDir,
      startTime,
      onOutput,
      onTerminalStreamedOutputFlushed: finalizeCodexAuthSessionOnce,
    })
      .then((output) => {
        finalizeCodexAuthSessionOnce();
        resolve(output);
      })
      .catch((err: unknown) => {
        finalizeCodexAuthSessionOnce();
        logger.error(
          { err, processName, chatJid: input.chatJid, runId: input.runId },
          'Spawned agent process runner failed',
        );
        resolve({
          status: 'error',
          result: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}
