import fs from 'fs';
import path from 'path';

export class DirectWorkDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectWorkDirError';
  }
}

export function resolveDirectWorkDir(workDir: string): string {
  if (!workDir || !path.isAbsolute(workDir)) {
    throw new DirectWorkDirError(
      `Channel workDir must be an absolute path: ${workDir || '(missing)'}`,
    );
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(workDir);
  } catch {
    throw new DirectWorkDirError(`Channel workDir does not exist: ${workDir}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new DirectWorkDirError(
      `Channel workDir is not a directory: ${resolved}`,
    );
  }
  return resolved;
}
