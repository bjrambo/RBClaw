export const RBCLAW_ENV = {
  agentType: 'RBCLAW_AGENT_TYPE',
  chatJid: 'RBCLAW_CHAT_JID',
  globalDir: 'RBCLAW_GLOBAL_DIR',
  groupDir: 'RBCLAW_GROUP_DIR',
  groupFolder: 'RBCLAW_GROUP_FOLDER',
  hostIpcDir: 'RBCLAW_HOST_IPC_DIR',
  ipcDir: 'RBCLAW_IPC_DIR',
  isMain: 'RBCLAW_IS_MAIN',
  roomRole: 'RBCLAW_ROOM_ROLE',
  runId: 'RBCLAW_RUN_ID',
  runtimeTaskId: 'RBCLAW_RUNTIME_TASK_ID',
  workDir: 'RBCLAW_WORK_DIR',
} as const;

export type RbclawEnvName = (typeof RBCLAW_ENV)[keyof typeof RBCLAW_ENV];
