import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RemoteReviewEnvironment } from 'rbclaw-runners-shared';

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SERVICE_UNIT_PATTERN = /^[a-zA-Z0-9@_.:-]{1,128}$/;
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GLOB_PATTERN = /[*?{}[\]]/;
const DESTRUCTIVE_WEB_PATH_PATTERN =
  /(?:^|[/_.?&=-])(?:logout|signout|delete|destroy|remove|purge|revoke)(?:$|[/_.?&=-])/i;
const SECRET_PATH_SEGMENT_PATTERN =
  /(^|\/)(?:\.env(?:\..*)?|\.ssh|credentials?|secrets?|private|shadow|id_(?:rsa|dsa|ecdsa|ed25519))(?:\/|$)|\.(?:key|pem|p12|pfx|kdbx)$/i;

export interface ReviewWebAccessConfig {
  baseUrl: string;
  paths: string[];
  allowedOrigins: string[];
  allowedPrivateCidrs: string[];
}

export interface ReviewRemoteFileConfig {
  id: string;
  path: string;
}

export interface ReviewRemoteAccessConfig {
  sshProfile: string;
  allowedRoots: string[];
  serviceUnits: string[];
  journalUnits: string[];
  logFiles: ReviewRemoteFileConfig[];
  configFiles: ReviewRemoteFileConfig[];
}

export interface ReviewEnvironmentConfig {
  web?: ReviewWebAccessConfig;
  remote?: ReviewRemoteAccessConfig;
}

export interface ReviewAccessProfile {
  environments: Partial<
    Record<RemoteReviewEnvironment, ReviewEnvironmentConfig>
  >;
}

export interface SshAccessProfile {
  label: string;
  host: string;
  port: number;
  user: string;
  auth: 'agent' | 'key' | 'password';
  keyPath?: string;
  password?: string;
  workDir?: string;
}

export function resolveReviewAccessProfilesPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.REVIEW_ACCESS_PROFILES_FILE?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('REVIEW_ACCESS_PROFILES_FILE must be an absolute path');
    }
    return configured;
  }
  return path.join(
    os.homedir(),
    '.server-access',
    'review-access-profiles.json',
  );
}

function assertPrivateFile(filePath: string): void {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Review access profile is not a file: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Review access profile must not be group/world accessible: ${filePath}`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function validateProfileId(value: string, label: string): string {
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw new Error(`${label} has an invalid profile id`);
  }
  return value;
}

export function validateReviewAccessPath(value: string, label: string): string {
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute POSIX path`);
  }
  if (value.includes('\0') || GLOB_PATTERN.test(value)) {
    throw new Error(`${label} contains forbidden path syntax`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.split('/').includes('..')) {
    throw new Error(`${label} must be normalized and cannot contain traversal`);
  }
  if (SECRET_PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} targets a denied secret path`);
  }
  return value;
}

export function isPathWithinAllowedRoots(
  targetPath: string,
  allowedRoots: readonly string[],
): boolean {
  return allowedRoots.some(
    (root) => targetPath === root || targetPath.startsWith(`${root}/`),
  );
}

function parseRemoteFileList(
  value: unknown,
  label: string,
  allowedRoots: readonly string[],
): ReviewRemoteFileConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `${label}[${index}]`);
    const id = asString(record.id, `${label}[${index}].id`);
    if (!ENTRY_ID_PATTERN.test(id) || ids.has(id)) {
      throw new Error(`${label}[${index}].id is invalid or duplicated`);
    }
    ids.add(id);
    const filePath = validateReviewAccessPath(
      asString(record.path, `${label}[${index}].path`),
      `${label}[${index}].path`,
    );
    if (!isPathWithinAllowedRoots(filePath, allowedRoots)) {
      throw new Error(`${label}[${index}].path is outside allowedRoots`);
    }
    return { id, path: filePath };
  });
}

function parseWebConfig(value: unknown, label: string): ReviewWebAccessConfig {
  const record = asRecord(value, label);
  const baseUrl = new URL(asString(record.baseUrl, `${label}.baseUrl`));
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
    throw new Error(
      `${label}.baseUrl must be an HTTPS origin without credentials`,
    );
  }
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new Error(
      `${label}.baseUrl must not contain a path, query, or fragment`,
    );
  }
  const paths = asStringArray(record.paths, `${label}.paths`);
  if (paths.length === 0) {
    throw new Error(`${label}.paths must contain at least one path`);
  }
  for (const configuredPath of paths) {
    const parsed = new URL(configuredPath, baseUrl);
    if (parsed.origin !== baseUrl.origin || parsed.hash) {
      throw new Error(`${label}.paths must stay within the configured origin`);
    }
    if (
      parsed.pathname !== configuredPath &&
      `${parsed.pathname}${parsed.search}` !== configuredPath
    ) {
      throw new Error(`${label}.paths must be normalized absolute URL paths`);
    }
    if (
      DESTRUCTIVE_WEB_PATH_PATTERN.test(`${parsed.pathname}${parsed.search}`)
    ) {
      throw new Error(`${label}.paths contains a denied side-effect path`);
    }
  }
  const allowedOrigins = asStringArray(
    record.allowedOrigins,
    `${label}.allowedOrigins`,
  ).map((origin, index) => {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        `${label}.allowedOrigins[${index}] must be an HTTPS origin`,
      );
    }
    return parsed.origin;
  });
  return {
    baseUrl: baseUrl.origin,
    paths: [...new Set(paths)],
    allowedOrigins: [...new Set(allowedOrigins)],
    allowedPrivateCidrs: asStringArray(
      record.allowedPrivateCidrs,
      `${label}.allowedPrivateCidrs`,
    ),
  };
}

function parseRemoteConfig(
  value: unknown,
  label: string,
): ReviewRemoteAccessConfig {
  const record = asRecord(value, label);
  const sshProfile = validateProfileId(
    asString(record.sshProfile, `${label}.sshProfile`),
    `${label}.sshProfile`,
  );
  const allowedRoots = asStringArray(
    record.allowedRoots,
    `${label}.allowedRoots`,
  ).map((root, index) =>
    validateReviewAccessPath(root, `${label}.allowedRoots[${index}]`),
  );
  if (allowedRoots.length === 0) {
    throw new Error(`${label}.allowedRoots must contain at least one path`);
  }
  const serviceUnits = asStringArray(
    record.serviceUnits,
    `${label}.serviceUnits`,
  );
  const journalUnits = asStringArray(
    record.journalUnits,
    `${label}.journalUnits`,
  );
  for (const unit of [...serviceUnits, ...journalUnits]) {
    if (!SERVICE_UNIT_PATTERN.test(unit)) {
      throw new Error(`${label} contains an invalid service unit`);
    }
  }
  return {
    sshProfile,
    allowedRoots: [...new Set(allowedRoots)],
    serviceUnits: [...new Set(serviceUnits)],
    journalUnits: [...new Set(journalUnits)],
    logFiles: parseRemoteFileList(
      record.logFiles,
      `${label}.logFiles`,
      allowedRoots,
    ),
    configFiles: parseRemoteFileList(
      record.configFiles,
      `${label}.configFiles`,
      allowedRoots,
    ),
  };
}

function parseEnvironment(
  value: unknown,
  label: string,
): ReviewEnvironmentConfig {
  const record = asRecord(value, label);
  const environment: ReviewEnvironmentConfig = {};
  if (record.web !== undefined) {
    environment.web = parseWebConfig(record.web, `${label}.web`);
  }
  if (record.remote !== undefined) {
    environment.remote = parseRemoteConfig(record.remote, `${label}.remote`);
  }
  if (!environment.web && !environment.remote) {
    throw new Error(`${label} must configure web or remote access`);
  }
  return environment;
}

export function loadReviewAccessProfile(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env,
): ReviewAccessProfile {
  validateProfileId(profileId, 'reviewAccessProfile');
  const filePath = resolveReviewAccessProfilesPath(env);
  assertPrivateFile(filePath);
  const root = asRecord(
    JSON.parse(fs.readFileSync(filePath, 'utf8')),
    filePath,
  );
  if (root.version !== 1) {
    throw new Error('Review access profile file version must be 1');
  }
  const profiles = asRecord(root.profiles, 'profiles');
  const profile = asRecord(profiles[profileId], `profiles.${profileId}`);
  const environments = asRecord(
    profile.environments,
    `profiles.${profileId}.environments`,
  );
  const result: ReviewAccessProfile = { environments: {} };
  for (const environment of ['development', 'production'] as const) {
    if (environments[environment] !== undefined) {
      result.environments[environment] = parseEnvironment(
        environments[environment],
        `profiles.${profileId}.environments.${environment}`,
      );
    }
  }
  if (Object.keys(result.environments).length === 0) {
    throw new Error(`Review access profile has no environments: ${profileId}`);
  }
  return result;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function loadSshAccessProfile(
  profileId: string,
  serverAccessDir = path.join(os.homedir(), '.server-access'),
): SshAccessProfile {
  validateProfileId(profileId, 'sshProfile');
  const filePath = path.join(serverAccessDir, `${profileId}.env`);
  assertPrivateFile(filePath);
  const values = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  const authValue = (values.SSH_AUTH || 'agent').trim().toLowerCase();
  if (!['agent', 'key', 'password'].includes(authValue)) {
    throw new Error(`Unsupported SSH_AUTH in profile ${profileId}`);
  }
  const port = Number(values.SSH_PORT || '22');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SSH_PORT in profile ${profileId}`);
  }
  const result: SshAccessProfile = {
    label: values.SSH_LABEL?.trim() || profileId,
    host: asString(values.SSH_HOST, `${profileId}.SSH_HOST`),
    port,
    user: asString(values.SSH_USER, `${profileId}.SSH_USER`),
    auth: authValue as SshAccessProfile['auth'],
    workDir: values.SSH_WORK_DIR?.trim() || undefined,
  };
  if (result.auth === 'key') {
    result.keyPath = asString(values.SSH_KEY_PATH, `${profileId}.SSH_KEY_PATH`);
  }
  if (result.auth === 'password') {
    result.password = asString(
      values.SSH_PASSWORD,
      `${profileId}.SSH_PASSWORD`,
    );
  }
  return result;
}
