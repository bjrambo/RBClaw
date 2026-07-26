import type { PairedSupervisorState, PairedTask } from './types.js';
import { updatePairedTaskIfUnchanged } from './db.js';
import { logger } from './logger.js';

export const PAIRED_SUPERVISOR_STATES = [
  'runnable',
  'waiting_retry',
  'waiting_external',
  'waiting_user',
  'parked',
  'terminal',
] as const satisfies readonly PairedSupervisorState[];

export const ALLOWED_PAIRED_SUPERVISOR_TRANSITIONS: Record<
  PairedSupervisorState,
  ReadonlySet<PairedSupervisorState>
> = {
  runnable: new Set([
    'waiting_retry',
    'waiting_external',
    'waiting_user',
    'parked',
    'terminal',
  ]),
  waiting_retry: new Set(['runnable', 'waiting_user', 'parked', 'terminal']),
  waiting_external: new Set(['runnable', 'waiting_user', 'parked', 'terminal']),
  waiting_user: new Set(['runnable', 'parked', 'terminal']),
  parked: new Set(['runnable', 'waiting_user', 'terminal']),
  terminal: new Set(),
};

export function resolvePairedSupervisorState(
  task: Pick<PairedTask, 'status' | 'supervisor_state'>,
): PairedSupervisorState {
  if (task.status === 'completed') return 'terminal';
  return task.supervisor_state ?? 'runnable';
}

export function assertPairedSupervisorTransition(args: {
  currentState: PairedSupervisorState;
  nextState: PairedSupervisorState;
}): void {
  if (args.currentState === args.nextState) return;
  if (
    ALLOWED_PAIRED_SUPERVISOR_TRANSITIONS[args.currentState].has(args.nextState)
  ) {
    return;
  }
  throw new Error(
    `Invalid paired supervisor transition: ${args.currentState} -> ${args.nextState}`,
  );
}

export function isPairedTaskRunnable(
  task: Pick<PairedTask, 'status' | 'supervisor_state' | 'resume_at'>,
  _now = new Date(),
): boolean {
  return (
    task.status !== 'completed' &&
    resolvePairedSupervisorState(task) === 'runnable'
  );
}

export function isPairedTaskRetryDue(
  task: Pick<PairedTask, 'status' | 'supervisor_state' | 'resume_at'>,
  now = new Date(),
): boolean {
  if (
    task.status === 'completed' ||
    resolvePairedSupervisorState(task) !== 'waiting_retry' ||
    !task.resume_at
  ) {
    return false;
  }
  return Date.parse(task.resume_at) <= now.getTime();
}

export function transitionPairedSupervisorState(args: {
  task: PairedTask;
  nextState: PairedSupervisorState;
  reason: string;
  now?: string;
  patch?: {
    last_blocker_class?: PairedTask['last_blocker_class'];
    resume_at?: string | null;
    retry_count?: number;
    stagnation_count?: number;
    external_wait_ref?: string | null;
  };
}): boolean {
  const previousState = resolvePairedSupervisorState(args.task);
  assertPairedSupervisorTransition({
    currentState: previousState,
    nextState: args.nextState,
  });
  const now = args.now ?? new Date().toISOString();
  const updated = updatePairedTaskIfUnchanged(
    args.task.id,
    args.task.updated_at,
    {
      ...args.patch,
      supervisor_state: args.nextState,
      supervisor_state_changed_at: now,
      updated_at: now,
    },
  );
  const fields = {
    taskId: args.task.id,
    chatJid: args.task.chat_jid,
    previousState,
    nextState: args.nextState,
    reason: args.reason,
    episode: args.task.episode_number ?? 1,
    episodeRoundTrips: args.task.round_trip_count,
    totalRoundTrips:
      args.task.total_round_trip_count ?? args.task.round_trip_count,
    arbitrationCount: args.task.arbitration_count ?? 0,
    stagnationCount:
      args.patch?.stagnation_count ?? args.task.stagnation_count ?? 0,
    progressFingerprintPrefix:
      args.task.progress_fingerprint?.slice(0, 12) ?? null,
    resumeAt: args.patch?.resume_at ?? args.task.resume_at ?? null,
  };
  if (updated) {
    logger.info(fields, 'Paired supervisor state transitioned');
  } else {
    logger.warn(fields, 'Skipped stale paired supervisor state transition');
  }
  return updated;
}
