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
      const filePath = path.join(workDir, relativePath);
      const stat = fs.lstatSync(filePath);
      hash.update(relativePath);
      hash.update('\0');
      hash.update(
        stat.isSymbolicLink()
          ? fs.readlinkSync(filePath)
          : fs.readFileSync(filePath),
      );
      hash.update('\0');
    }
    return `${WORK_DIR_FINGERPRINT_PREFIX}${hash.digest('hex')}`;
  } catch {
    return null;
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
