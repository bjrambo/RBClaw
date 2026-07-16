import fs from 'fs';
import path from 'path';

const tails = new Map<string, Promise<void>>();

function lockKey(workDir: string): string {
  try {
    return fs.realpathSync.native(workDir);
  } catch {
    return path.resolve(workDir);
  }
}

export async function acquireWorkDirExecutionLock(
  workDir: string,
): Promise<() => void> {
  const key = lockKey(workDir);
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  tails.set(key, tail);
  await previous.catch(() => undefined);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  };
}
