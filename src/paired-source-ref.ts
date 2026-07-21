import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const WORK_DIR_FINGERPRINT_PREFIX = 'workdir-v1:';

export function resolveCanonicalSourceRef(workDir: string): string {
  const fingerprint = resolveWorkDirFingerprint(workDir);
  return fingerprint || 'HEAD';
}

function resolveWorkDirFingerprint(workDir: string): string | null {
  try {
    const treeHash = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const trackedDiff = execFileSync(
      'git',
      ['diff', '--binary', 'HEAD', '--'],
      {
        cwd: workDir,
        encoding: null,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const untrackedOutput = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      {
        cwd: workDir,
        encoding: null,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const untrackedPaths = untrackedOutput
      .toString('utf-8')
      .split('\0')
      .filter(Boolean)
      .sort();

    const hash = crypto.createHash('sha256');
    hash.update(`tree\0${treeHash}\0diff\0`);
    hash.update(trackedDiff);
    hash.update('\0untracked\0');
    for (const relativePath of untrackedPaths) {
      updateHashForPath(hash, workDir, relativePath);
    }
    return `${WORK_DIR_FINGERPRINT_PREFIX}${hash.digest('hex')}`;
  } catch {
    return null;
  }
}

function updateHashForPath(
  hash: crypto.Hash,
  rootDir: string,
  relativePath: string,
): void {
  const filePath = path.join(rootDir, relativePath);
  const stat = fs.lstatSync(filePath);
  hash.update(relativePath);
  hash.update('\0');

  if (stat.isSymbolicLink()) {
    hash.update(fs.readlinkSync(filePath));
  } else if (stat.isFile()) {
    hash.update(fs.readFileSync(filePath));
  } else if (stat.isDirectory()) {
    const nestedFingerprint = isGitRepositoryRoot(filePath)
      ? resolveWorkDirFingerprint(filePath)
      : null;
    if (nestedFingerprint) {
      hash.update(`git-directory\0${nestedFingerprint}`);
    } else {
      hash.update('directory\0');
      for (const entry of fs.readdirSync(filePath).sort()) {
        if (entry === '.git') continue;
        updateHashForPath(hash, rootDir, path.join(relativePath, entry));
      }
    }
  } else {
    hash.update(`other\0${stat.mode}\0${stat.size}`);
  }

  hash.update('\0');
}

function isGitRepositoryRoot(directoryPath: string): boolean {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directoryPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return fs.realpathSync(topLevel) === fs.realpathSync(directoryPath);
  } catch {
    return false;
  }
}

export function hasCodeChangesSinceRef(
  workDir: string,
  sourceRef: string | null | undefined,
): boolean | null {
  if (!sourceRef) return null;
  if (sourceRef.startsWith(WORK_DIR_FINGERPRINT_PREFIX)) {
    const current = resolveWorkDirFingerprint(workDir);
    return current ? current !== sourceRef : null;
  }
  try {
    execFileSync('git', ['diff', '--quiet', sourceRef, '--'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const untracked = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
    return untracked.length > 0;
  } catch (error) {
    const exitCode =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : null;
    if (exitCode === 1) {
      return true;
    }
    return null;
  }
}
