import type { ChildProcess } from 'child_process';

export function signalProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  const pid = proc.pid;
  if (process.platform !== 'win32' && pid && pid > 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw err;
      }
    }
  }

  return proc.kill(signal);
}
