import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getAllCodexAccounts,
  getCodexAuthPath,
  updateCodexAccountUsage,
} from './codex-token-rotation.js';
import { formatResetRemaining, type UsageRow } from './dashboard-usage-rows.js';
import { logger } from './logger.js';

export interface CodexRateLimit {
  limitId?: string;
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: string | number };
  secondary: { usedPercent: number; resetsAt: string | number };
}

/**
 * Result returned by the refresh functions.
 * Caller is responsible for persisting into module-level cache.
 */
export interface CodexUsageRefreshResult {
  rows: UsageRow[];
  /** Non-null only when at least one account was successfully fetched. */
  fetchedAt: string | null;
}

/** Full scan interval — exported so the orchestrator can schedule it. */
export const CODEX_FULL_SCAN_INTERVAL = 3_600_000; // 1 hour
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function getPreferredCodexPathEntries(): string[] {
  const entries = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  if (process.versions.bun || path.basename(process.execPath) === 'bun') {
    entries.push(path.join(os.homedir(), '.hermes', 'node', 'bin'));
  }
  return [...new Set(entries)];
}

function getCodexHomeForAccount(accountIndex?: number): string | null {
  const authPath = getCodexAuthPath(accountIndex);
  if (!authPath || !fs.existsSync(authPath)) return null;
  return path.dirname(authPath);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resetAtOrUndefined(value: unknown): string | number | undefined {
  const resetAt = numberOrNull(value);
  return resetAt == null ? undefined : resetAt;
}

function readCodexAccessToken(codexHome: string): string | null {
  const file = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(file)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      tokens?: { access_token?: unknown };
    };
    return typeof data.tokens?.access_token === 'string'
      ? data.tokens.access_token
      : null;
  } catch {
    return null;
  }
}

function writeCodexPlanStatus(codexHome: string, value: unknown): void {
  const file = path.join(codexHome, 'plan-status.json');
  try {
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    try {
      fs.rmSync(`${file}.tmp`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function codexRateLimitFromWhamUsage(value: unknown): CodexRateLimit[] | null {
  try {
    const data = value as {
      rate_limit?: {
        primary_window?: {
          used_percent?: unknown;
          reset_at?: unknown;
        };
        secondary_window?: {
          used_percent?: unknown;
          reset_at?: unknown;
        };
      };
    };
    const primary = data.rate_limit?.primary_window;
    const secondary = data.rate_limit?.secondary_window;
    const primaryUsed = numberOrNull(primary?.used_percent);
    const secondaryUsed = numberOrNull(secondary?.used_percent);
    if (primaryUsed == null && secondaryUsed == null) return null;

    return [
      {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: primaryUsed ?? -1,
          resetsAt: resetAtOrUndefined(primary?.reset_at) ?? '',
        },
        secondary: {
          usedPercent: secondaryUsed ?? -1,
          resetsAt: resetAtOrUndefined(secondary?.reset_at) ?? '',
        },
      },
    ];
  } catch {
    return null;
  }
}

export async function fetchCodexLiveUsage(
  codexHome: string,
): Promise<CodexRateLimit[] | null> {
  const accessToken = readCodexAccessToken(codexHome);
  if (!accessToken) return null;

  try {
    const res = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    const checkedAt = new Date().toISOString();
    writeCodexPlanStatus(codexHome, {
      ...(json && typeof json === 'object' ? json : {}),
      checked_at: checkedAt,
    });
    return codexRateLimitFromWhamUsage(json);
  } catch {
    return null;
  }
}

async function fetchCodexUsageWithLiveFallback(
  codexHome: string,
): Promise<CodexRateLimit[] | null> {
  const liveUsage = await fetchCodexLiveUsage(codexHome);
  if (liveUsage && liveUsage.length > 0) return liveUsage;
  return fetchCodexUsage(codexHome);
}

export async function fetchCodexUsage(
  codexHomeOverride?: string,
): Promise<CodexRateLimit[] | null> {
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const codexBin = fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';

  return new Promise((resolve) => {
    let done = false;
    let proc: ChildProcess | null = null;
    const finish = (value: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (proc) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 20_000);

    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: [...getPreferredCodexPathEntries(), process.env.PATH || '']
        .filter(Boolean)
        .join(path.delimiter),
    };
    if (codexHomeOverride) {
      spawnEnv.CODEX_HOME = codexHomeOverride;
    }

    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
      });
    } catch {
      resolve(null);
      return;
    }

    if (!proc.stdout || !proc.stdin) {
      finish(null);
      return;
    }

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            proc!.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (message.id === 2 && message.result) {
            const byId = message.result.rateLimitsByLimitId;
            finish(
              byId && typeof byId === 'object'
                ? Object.entries(byId).map(([id, val]) => ({
                    ...(val as CodexRateLimit),
                    limitId: id,
                  }))
                : null,
            );
          }
        } catch {
          /* ignore */
        }
      }
    });

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'usage-monitor', version: '1.0' } },
      }) + '\n',
    );
  });
}

/**
 * Extract usage percentages from the primary 'codex' rate-limit bucket
 * and update the rotation state for a given account.
 *
 * Bucket selection:
 *  1. limitId === 'codex' → use it
 *  2. No 'codex' bucket + single bucket → use it
 *  3. No 'codex' bucket + multiple buckets → unknown (show —)
 *
 * All buckets are logged at info level for observability.
 */
export function applyCodexUsageToAccount(
  usage: CodexRateLimit[],
  accountIndex: number,
): void {
  if (usage.length === 0) return;

  // Log all buckets for observability
  logger.info(
    {
      account: accountIndex + 1,
      buckets: usage.map((l) => ({
        id: l.limitId,
        h5: l.primary.usedPercent,
        d7: l.secondary.usedPercent,
      })),
    },
    `Codex account #${accountIndex + 1}: ${usage.length} rate-limit bucket(s)`,
  );

  // Select the effective bucket
  const primaryBucket = usage.find((l) => l.limitId === 'codex');
  const effective = primaryBucket ?? (usage.length === 1 ? usage[0] : null);

  if (!effective) {
    // Multiple unknown buckets — cannot determine which is authoritative
    logger.warn(
      { account: accountIndex + 1 },
      `Codex account #${accountIndex + 1}: no 'codex' bucket found among ${usage.length} buckets, showing unknown`,
    );
    updateCodexAccountUsage(-1, undefined, accountIndex, -1, undefined);
    return;
  }

  const pct = Math.round(effective.primary.usedPercent);
  const d7Pct = Math.round(effective.secondary.usedPercent);
  const resetStr = effective.primary.resetsAt
    ? formatResetRemaining(effective.primary.resetsAt)
    : undefined;
  const resetD7Str = effective.secondary.resetsAt
    ? formatResetRemaining(effective.secondary.resetsAt)
    : undefined;
  updateCodexAccountUsage(pct, resetStr, accountIndex, d7Pct, resetD7Str);
  logger.info(
    {
      account: accountIndex + 1,
      bucket: effective.limitId,
      h5: pct,
      d7: d7Pct,
      reset: resetStr,
    },
    `Codex account #${accountIndex + 1} usage: 5h=${pct}% 7d=${d7Pct}%`,
  );
}

/**
 * Build display-ready usage rows from Codex rotation state.
 * Called after refreshing usage data.
 */
export function buildCodexUsageRowsFromState(): UsageRow[] {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length === 0) return [];

  const isMulti = codexAccounts.length > 1;
  return codexAccounts.map((acct) => {
    const icon = acct.isActive ? '*' : acct.isRateLimited ? '!' : ' ';
    const label = isMulti
      ? `Codex${acct.index + 1}${icon} ${acct.planType}`
      : 'Codex';
    return {
      name: label,
      h5pct: acct.cachedUsagePct != null ? acct.cachedUsagePct : -1,
      h5reset: acct.resetAt || '',
      d7pct: acct.cachedUsageD7Pct != null ? acct.cachedUsageD7Pct : -1,
      d7reset: acct.resetD7At || '',
    };
  });
}

/**
 * Scan ALL Codex accounts by spawning app-server with each auth.
 * Returns refresh result — caller owns cache state.
 */
export async function refreshAllCodexAccountUsage(): Promise<CodexUsageRefreshResult> {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length === 0) {
    return { rows: buildCodexUsageRowsFromState(), fetchedAt: null };
  }

  logger.info(
    { accountCount: codexAccounts.length },
    'Scanning all Codex accounts for usage data',
  );

  let anySuccess = false;
  for (const acct of codexAccounts) {
    const accountDir = getCodexHomeForAccount(acct.index);
    if (!accountDir) continue;

    try {
      const usage = await fetchCodexUsageWithLiveFallback(accountDir);
      if (usage && Array.isArray(usage) && usage.length > 0) {
        applyCodexUsageToAccount(usage, acct.index);
        anySuccess = true;
      }
    } catch (err) {
      logger.debug(
        { err, account: acct.index + 1 },
        'Failed to fetch usage for Codex account',
      );
    }
  }

  return {
    rows: buildCodexUsageRowsFromState(),
    fetchedAt: anySuccess ? new Date().toISOString() : null,
  };
}

/**
 * Quick-refresh the active Codex account's usage.
 * Returns refresh result — caller owns cache state.
 */
export async function refreshActiveCodexUsage(): Promise<CodexUsageRefreshResult> {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length === 0) {
    return { rows: [], fetchedAt: null };
  }

  const active = codexAccounts.find((a) => a.isActive);
  if (!active) {
    return { rows: buildCodexUsageRowsFromState(), fetchedAt: null };
  }

  const accountDir = getCodexHomeForAccount(active.index);
  if (!accountDir) {
    return { rows: buildCodexUsageRowsFromState(), fetchedAt: null };
  }

  let fetchedAt: string | null = null;
  try {
    const usage = await fetchCodexUsageWithLiveFallback(accountDir);
    if (usage && Array.isArray(usage) && usage.length > 0) {
      applyCodexUsageToAccount(usage, active.index);
      fetchedAt = new Date().toISOString();
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to fetch active Codex account usage');
  }

  return { rows: buildCodexUsageRowsFromState(), fetchedAt };
}
