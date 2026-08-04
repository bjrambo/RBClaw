import { createHash } from 'crypto';
import dns from 'dns';
import { execFile } from 'child_process';
import https from 'https';
import net, { type LookupFunction } from 'net';
import os from 'os';
import path from 'path';

import type { Database } from 'bun:sqlite';
import type {
  RemoteReviewCheck,
  RemoteReviewEnvironment,
} from 'rbclaw-runners-shared';

import {
  isPathWithinAllowedRoots,
  loadReviewAccessProfile,
  loadSshAccessProfile,
  type ReviewEnvironmentConfig,
  type ReviewRemoteAccessConfig,
  type ReviewRemoteFileConfig,
  type ReviewWebAccessConfig,
  type SshAccessProfile,
} from './review-access-profile.js';

const WEB_TIMEOUT_MS = 8_000;
const WEB_MAX_BODY_BYTES = 256 * 1024;
const SSH_TIMEOUT_MS = 10_000;
const SSH_MAX_BUFFER = 1024 * 1024;
const REMOTE_FILE_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_LINES = 80;

export interface RemoteReviewInspectionRequest {
  sourceGroup: string;
  roomRole?: string;
  pairedTaskId?: string;
  environment: RemoteReviewEnvironment;
  check: RemoteReviewCheck;
}

export interface RemoteReviewInspectionDeps {
  database: Database;
  loadProfile?: typeof loadReviewAccessProfile;
  inspectWeb?: typeof inspectWebEnvironment;
  runSsh?: typeof runSshReadOnly;
  serverAccessDir?: string;
}

interface RoomReviewAccessRow {
  chat_jid: string;
  review_access_profile: string | null;
}

interface PairedReviewTaskRow {
  id: string;
  status: string;
}

interface RemoteCommandResult {
  stdout: string;
  stderr: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function truncate(value: string, max = 16_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function resolveRoomReviewAccessProfile(
  database: Database,
  sourceGroup: string,
): RoomReviewAccessRow | undefined {
  return database
    .prepare(
      `SELECT chat_jid, review_access_profile
       FROM room_settings
       WHERE folder = ?`,
    )
    .get(sourceGroup) as RoomReviewAccessRow | undefined;
}

function redactDiagnosticText(value: string): string {
  return truncate(
    value
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        '[redacted-email]',
      )
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
      .replace(
        /([?&](?:token|key|secret|code|password|auth)=)[^&\s]+/gi,
        '$1[redacted]',
      )
      .replace(
        /\b(authorization|cookie|set-cookie|password|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
        '$1=[redacted]',
      ),
  );
}

function buildDeniedAddressList(): net.BlockList {
  const blockList = new net.BlockList();
  const ipv4: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  const ipv6: Array<[string, number]> = [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32],
  ];
  for (const [address, prefix] of ipv4) {
    blockList.addSubnet(address, prefix, 'ipv4');
  }
  for (const [address, prefix] of ipv6) {
    blockList.addSubnet(address, prefix, 'ipv6');
  }
  return blockList;
}

function buildAllowedAddressList(cidrs: readonly string[]): net.BlockList {
  const blockList = new net.BlockList();
  for (const cidr of cidrs) {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(cidr);
    if (!match) throw new Error(`Invalid allowed private CIDR: ${cidr}`);
    const family = net.isIP(match[1]);
    const prefix = Number(match[2]);
    if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`Invalid allowed private CIDR: ${cidr}`);
    }
    blockList.addSubnet(match[1], prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return blockList;
}

function assertAllowedAddress(
  address: string,
  denied: net.BlockList,
  allowed: net.BlockList,
): void {
  const family = net.isIP(address);
  if (!family) throw new Error('DNS returned a non-IP address');
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (denied.check(address, type) && !allowed.check(address, type)) {
    throw new Error('Web inspection resolved to a denied network address');
  }
}

async function resolvePinnedAddress(
  hostname: string,
  allowedPrivateCidrs: readonly string[],
): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await dns.promises.lookup(hostname, { all: true });
  if (addresses.length === 0)
    throw new Error('Web inspection DNS returned no addresses');
  const denied = buildDeniedAddressList();
  const allowed = buildAllowedAddressList(allowedPrivateCidrs);
  for (const entry of addresses) {
    assertAllowedAddress(entry.address, denied, allowed);
  }
  return addresses[0] as { address: string; family: 4 | 6 };
}

function isConfiguredWebPath(url: URL, config: ReviewWebAccessConfig): boolean {
  return (
    url.origin === config.baseUrl &&
    config.paths.includes(`${url.pathname}${url.search}`)
  );
}

function createPinnedLookup(pinned: {
  address: string;
  family: 4 | 6;
}): LookupFunction {
  return (_hostname, options, callback): void => {
    if (options?.all) {
      callback(null, [pinned]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

async function requestWebPath(
  initialUrl: URL,
  config: ReviewWebAccessConfig,
  redirects = 0,
): Promise<Record<string, unknown>> {
  if (!isConfiguredWebPath(initialUrl, config)) {
    throw new Error('Web inspection URL is outside the configured allowlist');
  }
  if (!isSafeReadOnlyWebRequest('GET', initialUrl)) {
    throw new Error('Web inspection URL is not safe for a read-only request');
  }
  const pinned = await resolvePinnedAddress(
    initialUrl.hostname,
    config.allowedPrivateCidrs,
  );
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        hostname: initialUrl.hostname,
        port: initialUrl.port || 443,
        path: `${initialUrl.pathname}${initialUrl.search}`,
        method: 'GET',
        servername: initialUrl.hostname,
        headers: {
          accept: 'text/html,application/json;q=0.8,*/*;q=0.5',
          'user-agent': 'RBClaw-Reviewer/1.0',
          'cache-control': 'no-cache',
        },
        lookup: createPinnedLookup(pinned),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirects >= 2) {
            reject(new Error('Web inspection exceeded redirect limit'));
            return;
          }
          const redirectUrl = new URL(location, initialUrl);
          if (!isConfiguredWebPath(redirectUrl, config)) {
            reject(
              new Error(
                'Web inspection redirect left the configured allowlist',
              ),
            );
            return;
          }
          requestWebPath(redirectUrl, config, redirects + 1).then(
            resolve,
            reject,
          );
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > WEB_MAX_BODY_BYTES) {
            request.destroy(
              new Error('Web inspection response exceeded size limit'),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          const text = body.toString('utf8');
          const title = /<title[^>]*>([^<]{0,200})<\/title>/i
            .exec(text)?.[1]
            ?.replace(/\s+/g, ' ')
            .trim();
          resolve({
            path: `${initialUrl.pathname}${initialUrl.search}`,
            status,
            contentType: response.headers['content-type'] ?? null,
            contentLength: response.headers['content-length'] ?? body.length,
            title: title || null,
            bodySha256: createHash('sha256').update(body).digest('hex'),
          });
        });
      },
    );
    request.setTimeout(WEB_TIMEOUT_MS, () => {
      request.destroy(new Error('Web inspection timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

function sanitizeObservedUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function isSafeReadOnlyWebRequest(method: string, url: URL): boolean {
  if (!['GET', 'HEAD'].includes(method)) return false;
  return !/(?:^|[/_.?&=-])(?:logout|signout|delete|destroy|remove|purge|revoke)(?:$|[/_.?&=-])/i.test(
    `${url.pathname}${url.search}`,
  );
}

async function inspectBrowserPath(
  initialUrl: URL,
  config: ReviewWebAccessConfig,
): Promise<Record<string, unknown>> {
  const { chromium } = await import('playwright');
  const allowedOrigins = new Set([config.baseUrl, ...config.allowedOrigins]);
  const pinnedHosts = new Map<string, { address: string; family: 4 | 6 }>();
  for (const origin of allowedOrigins) {
    const hostname = new URL(origin).hostname;
    pinnedHosts.set(
      hostname,
      await resolvePinnedAddress(hostname, config.allowedPrivateCidrs),
    );
  }
  const resolverRules = [...pinnedHosts]
    .map(([hostname, pinned]) => `MAP ${hostname} ${pinned.address}`)
    .join(',');
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=${resolverRules},EXCLUDE localhost`],
  });
  const viewports = [
    { name: 'desktop', width: 1440, height: 900, isMobile: false },
    { name: 'mobile', width: 390, height: 844, isMobile: true },
  ] as const;
  const results: Record<string, unknown>[] = [];
  try {
    for (const viewport of viewports) {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedRequests: string[] = [];
      const badResponses: Array<{ url: string; status: number }> = [];
      const blockedRequests: Array<{ method: string; url: string }> = [];
      const blockedRequestUrls = new Set<string>();
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        serviceWorkers: 'block',
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const requestUrl = new URL(request.url());
        const readOnlyRequest = isSafeReadOnlyWebRequest(
          request.method(),
          requestUrl,
        );
        const allowedOrigin =
          requestUrl.protocol === 'https:' &&
          allowedOrigins.has(requestUrl.origin);
        const allowedNavigation =
          !request.isNavigationRequest() ||
          isConfiguredWebPath(requestUrl, config);
        if (!readOnlyRequest || !allowedOrigin || !allowedNavigation) {
          blockedRequestUrls.add(request.url());
          blockedRequests.push({
            method: request.method(),
            url: sanitizeObservedUrl(request.url()),
          });
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          !message.text().includes('ERR_BLOCKED_BY_CLIENT')
        ) {
          consoleErrors.push(
            redactDiagnosticText(message.text()).slice(0, 500),
          );
        }
      });
      page.on('pageerror', (error) => {
        pageErrors.push(redactDiagnosticText(error.message).slice(0, 500));
      });
      page.on('requestfailed', (request) => {
        if (!blockedRequestUrls.has(request.url())) {
          failedRequests.push(sanitizeObservedUrl(request.url()));
        }
      });
      page.on('response', (response) => {
        if (response.status() >= 400) {
          badResponses.push({
            url: sanitizeObservedUrl(response.url()),
            status: response.status(),
          });
        }
      });
      try {
        const response = await page.goto(initialUrl.href, {
          waitUntil: 'domcontentloaded',
          timeout: WEB_TIMEOUT_MS,
        });
        await page.waitForTimeout(500);
        results.push({
          viewport: viewport.name,
          status: response?.status() ?? null,
          finalPath: new URL(page.url()).pathname,
          title: (await page.title()).slice(0, 200),
          consoleErrors: consoleErrors.slice(0, 20),
          pageErrors: pageErrors.slice(0, 20),
          failedRequests: [...new Set(failedRequests)].slice(0, 20),
          badResponses: badResponses.slice(0, 20),
          blockedRequests: blockedRequests.slice(0, 20),
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { viewports: results };
}

export async function inspectWebEnvironment(
  config: ReviewWebAccessConfig,
): Promise<Record<string, unknown>> {
  const checks = [];
  for (const configuredPath of config.paths) {
    const url = new URL(configuredPath, config.baseUrl);
    const http = await requestWebPath(url, config);
    let browser: Record<string, unknown>;
    try {
      browser = await inspectBrowserPath(url, config);
    } catch (error) {
      browser = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    checks.push({ ...http, browser });
  }
  return { baseUrl: config.baseUrl, checks };
}

export async function runSshReadOnly(
  ssh: SshAccessProfile,
  script: string,
  label: string,
): Promise<RemoteCommandResult> {
  const args = [
    '-T',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${path.join(os.homedir(), '.server-access', 'known_hosts')}`,
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'PermitLocalCommand=no',
    '-p',
    String(ssh.port),
  ];
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (ssh.auth === 'key') {
    args.push('-o', 'BatchMode=yes', '-i', ssh.keyPath!);
  } else if (ssh.auth === 'password') {
    args.push('-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1');
    childEnv.SSH_ASKPASS = path.join(
      os.homedir(),
      '.server-access',
      'askpass.sh',
    );
    childEnv.SSH_ASKPASS_REQUIRE = 'force';
    childEnv.DISPLAY = childEnv.DISPLAY || ':0';
    childEnv.SSH_PASSWORD = ssh.password!;
  } else {
    args.push('-o', 'BatchMode=yes');
  }
  args.push(`${ssh.user}@${ssh.host}`, 'sh', '-lc', shellQuote(script));

  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      args,
      {
        encoding: 'utf8',
        timeout: SSH_TIMEOUT_MS,
        maxBuffer: SSH_MAX_BUFFER,
        env: childEnv,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${label} failed with exit code ${typeof error.code === 'number' ? error.code : 1}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function buildResolvedFileReadScript(
  file: ReviewRemoteFileConfig,
  remote: ReviewRemoteAccessConfig,
  mode: 'file' | 'tail',
): string {
  const allowedCases = remote.allowedRoots
    .map((root) => `${shellQuote(root)}|${shellQuote(root)}/*`)
    .join('|');
  const readCommand =
    mode === 'tail'
      ? `tail -n ${LOG_TAIL_LINES} -- "$resolved"`
      : `size=$(wc -c < "$resolved"); [ "$size" -le ${REMOTE_FILE_MAX_BYTES} ] || exit 74; cat -- "$resolved"`;
  return [
    'set -eu',
    `resolved=$(readlink -f -- ${shellQuote(file.path)})`,
    "lower=$(printf '%s' \"$resolved\" | tr '[:upper:]' '[:lower:]')",
    'case "$lower" in',
    `  ${allowedCases}) ;;`,
    '  *) exit 73 ;;',
    'esac',
    'case "$resolved" in',
    '  */.env|*/.env.*|*/.ssh/*|*credentials*|*secret*|*shadow*|*.key|*.pem|*.p12|*.pfx) exit 73 ;;',
    'esac',
    '[ -f "$resolved" ] || exit 72',
    readCommand,
  ].join('\n');
}

function extractConfigStructure(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    const keys = new Set<string>();
    const visit = (value: unknown, prefix: string): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const entry of value.slice(0, 20)) visit(entry, `${prefix}[]`);
        return;
      }
      for (const [key, nested] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const next = prefix ? `${prefix}.${key}` : key;
        keys.add(next);
        visit(nested, next);
      }
    };
    visit(parsed, '');
    return [...keys].sort().slice(0, 500);
  } catch {
    const keys = new Set<string>();
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (
        !line ||
        line.startsWith('#') ||
        line.startsWith(';') ||
        line.startsWith('//')
      )
        continue;
      const match = /^(?:<\/?\s*)?([A-Za-z_][A-Za-z0-9_.:-]*)\b/.exec(line);
      if (match) keys.add(match[1]);
    }
    return [...keys].sort().slice(0, 500);
  }
}

async function inspectConfigShape(
  environment: ReviewEnvironmentConfig,
  runSsh: typeof runSshReadOnly,
  serverAccessDir?: string,
): Promise<Record<string, unknown>> {
  const remote = environment.remote;
  if (!remote || remote.configFiles.length === 0) {
    throw new Error('The selected environment has no allowlisted config files');
  }
  const ssh = loadSshAccessProfile(remote.sshProfile, serverAccessDir);
  const files = [];
  for (const file of remote.configFiles) {
    const result = await runSsh(
      ssh,
      buildResolvedFileReadScript(file, remote, 'file'),
      `inspect_config_shape:${file.id}`,
    );
    files.push({
      id: file.id,
      sha256: createHash('sha256').update(result.stdout).digest('hex'),
      keys: extractConfigStructure(result.stdout),
    });
  }
  return { files };
}

async function inspectServiceStatus(
  environment: ReviewEnvironmentConfig,
  runSsh: typeof runSshReadOnly,
  serverAccessDir?: string,
): Promise<Record<string, unknown>> {
  const remote = environment.remote;
  if (!remote || remote.serviceUnits.length === 0) {
    throw new Error(
      'The selected environment has no allowlisted service units',
    );
  }
  const ssh = loadSshAccessProfile(remote.sshProfile, serverAccessDir);
  const units = remote.serviceUnits.map(shellQuote).join(' ');
  const script = `systemctl show --no-pager --property=Id,LoadState,ActiveState,SubState,ExecMainCode,ExecMainStatus ${units}`;
  const result = await runSsh(ssh, script, 'inspect_service_status');
  return { status: redactDiagnosticText(result.stdout) };
}

async function inspectRecentLogs(
  environment: ReviewEnvironmentConfig,
  runSsh: typeof runSshReadOnly,
  serverAccessDir?: string,
): Promise<Record<string, unknown>> {
  const remote = environment.remote;
  if (
    !remote ||
    (remote.journalUnits.length === 0 && remote.logFiles.length === 0)
  ) {
    throw new Error('The selected environment has no allowlisted log sources');
  }
  const ssh = loadSshAccessProfile(remote.sshProfile, serverAccessDir);
  const output: Array<{ source: string; content: string }> = [];
  for (const unit of remote.journalUnits) {
    const result = await runSsh(
      ssh,
      `journalctl --no-pager -n ${LOG_TAIL_LINES} -o short-iso --unit ${shellQuote(unit)}`,
      `inspect_recent_logs:${unit}`,
    );
    output.push({
      source: `journal:${unit}`,
      content: redactDiagnosticText(result.stdout),
    });
  }
  for (const file of remote.logFiles) {
    const result = await runSsh(
      ssh,
      buildResolvedFileReadScript(file, remote, 'tail'),
      `inspect_recent_logs:${file.id}`,
    );
    output.push({
      source: `file:${file.id}`,
      content: redactDiagnosticText(result.stdout),
    });
  }
  return { logs: output };
}

async function compareEnvironmentConfigs(
  profile: ReturnType<typeof loadReviewAccessProfile>,
  runSsh: typeof runSshReadOnly,
  serverAccessDir?: string,
): Promise<Record<string, unknown>> {
  const development = profile.environments.development;
  const production = profile.environments.production;
  if (!development || !production) {
    throw new Error(
      'compare_environments requires development and production profiles',
    );
  }
  const dev = await inspectConfigShape(development, runSsh, serverAccessDir);
  const prod = await inspectConfigShape(production, runSsh, serverAccessDir);
  return { development: dev, production: prod };
}

export async function runRemoteReviewInspection(
  request: RemoteReviewInspectionRequest,
  deps: RemoteReviewInspectionDeps,
): Promise<string> {
  if (request.roomRole !== 'reviewer') {
    throw new Error(
      'Remote review inspection is restricted to the reviewer role',
    );
  }
  const room = resolveRoomReviewAccessProfile(
    deps.database,
    request.sourceGroup,
  );
  if (!room?.review_access_profile) {
    throw new Error('Remote review inspection is not enabled for this room');
  }
  if (!request.pairedTaskId) {
    throw new Error('Remote review inspection requires a paired reviewer task');
  }
  const pairedTask = deps.database
    .prepare(
      `SELECT id, status
         FROM paired_tasks
        WHERE id = ?
          AND group_folder = ?
          AND chat_jid = ?`,
    )
    .get(request.pairedTaskId, request.sourceGroup, room.chat_jid) as
    | PairedReviewTaskRow
    | undefined;
  if (!pairedTask || pairedTask.status !== 'in_review') {
    throw new Error('Remote review inspection has no active reviewer turn');
  }
  const loadProfile = deps.loadProfile ?? loadReviewAccessProfile;
  const profile = loadProfile(room.review_access_profile);
  const environment = profile.environments[request.environment];
  if (!environment) {
    throw new Error(
      `Review environment is not configured: ${request.environment}`,
    );
  }
  const inspectWeb = deps.inspectWeb ?? inspectWebEnvironment;
  const runSsh = deps.runSsh ?? runSshReadOnly;
  let result: Record<string, unknown>;
  switch (request.check) {
    case 'inspect_web':
      if (!environment.web) {
        throw new Error(
          'The selected environment has no web inspection config',
        );
      }
      result = await inspectWeb(environment.web);
      break;
    case 'inspect_service_status':
      result = await inspectServiceStatus(
        environment,
        runSsh,
        deps.serverAccessDir,
      );
      break;
    case 'inspect_recent_logs':
      result = await inspectRecentLogs(
        environment,
        runSsh,
        deps.serverAccessDir,
      );
      break;
    case 'inspect_config_shape':
      result = await inspectConfigShape(
        environment,
        runSsh,
        deps.serverAccessDir,
      );
      break;
    case 'compare_environments':
      result = await compareEnvironmentConfigs(
        profile,
        runSsh,
        deps.serverAccessDir,
      );
      break;
  }
  return JSON.stringify(
    {
      room: room.chat_jid,
      profile: room.review_access_profile,
      environment: request.environment,
      check: request.check,
      pairedTaskId: request.pairedTaskId ?? null,
      result,
    },
    null,
    2,
  );
}

export const remoteReviewTestHelpers = {
  extractConfigStructure,
  redactDiagnosticText,
  buildResolvedFileReadScript,
  isPathWithinAllowedRoots,
};
