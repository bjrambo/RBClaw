import path from 'path';
import { RBCLAW_ENV } from 'rbclaw-runners-shared';

export interface ResolvedIpcDirectories {
  ipcDir: string;
  hostIpcDir: string;
}

export function isTaskScopedIpcDir(ipcDir: string): boolean {
  const normalized = path.posix.normalize(ipcDir.replaceAll('\\', '/'));
  return /\/tasks\/[^/]+\/?$/.test(normalized);
}

export function resolveIpcDirectories(
  env: NodeJS.ProcessEnv,
): ResolvedIpcDirectories {
  const ipcDir = env[RBCLAW_ENV.ipcDir] || '/workspace/ipc';
  const hostIpcDir = env[RBCLAW_ENV.hostIpcDir];

  if (!hostIpcDir && isTaskScopedIpcDir(ipcDir)) {
    throw new Error(
      'RBCLAW_HOST_IPC_DIR is required for task-scoped IPC runtimes',
    );
  }

  return {
    ipcDir,
    hostIpcDir: hostIpcDir || ipcDir,
  };
}
