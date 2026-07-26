import { classifyAgentError } from './agent-error-detection.js';
import {
  PAIRED_RETRY_BASE_DELAY_MS,
  PAIRED_RETRY_MAX_DELAY_MS,
} from './config.js';
import { logger } from './logger.js';
import {
  applyPairedTaskPatch,
  transitionPairedTaskStatus,
} from './paired-task-status.js';
import type { PairedTask } from './types.js';

export function parkRetryablePairedFailure(args: {
  task: PairedTask;
  summary?: string | null;
}): boolean {
  const summary = args.summary ?? '';
  const classification = classifyAgentError(summary);
  const isHardTimeout = summary.toLowerCase().includes('hard turn timeout');
  const retryable =
    isHardTimeout ||
    classification.category === 'rate-limit' ||
    classification.category === 'overloaded' ||
    classification.category === 'network-error';
  if (!retryable) {
    return false;
  }

  const retryCount = (args.task.retry_count ?? 0) + 1;
  const configuredDelay =
    classification.category === 'rate-limit'
      ? classification.retryAfterMs
      : undefined;
  const exponentialDelay = Math.min(
    PAIRED_RETRY_MAX_DELAY_MS,
    PAIRED_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1),
  );
  const delayMs = Math.min(
    PAIRED_RETRY_MAX_DELAY_MS,
    configuredDelay ?? exponentialDelay,
  );
  const now = new Date();
  const updatedAt = now.toISOString();
  const patch = {
    supervisor_state: 'waiting_retry' as const,
    supervisor_state_changed_at: updatedAt,
    retry_count: retryCount,
    resume_at: new Date(now.getTime() + delayMs).toISOString(),
    last_blocker_class: isHardTimeout
      ? ('timeout' as const)
      : classification.category === 'network-error'
        ? ('network' as const)
        : ('provider' as const),
  };
  const nextStatus =
    args.task.status === 'in_review'
      ? 'review_ready'
      : args.task.status === 'in_arbitration'
        ? 'arbiter_requested'
        : args.task.status;

  if (nextStatus === args.task.status) {
    applyPairedTaskPatch({
      taskId: args.task.id,
      expectedUpdatedAt: args.task.updated_at,
      updatedAt,
      patch,
    });
  } else {
    transitionPairedTaskStatus({
      taskId: args.task.id,
      currentStatus: args.task.status,
      nextStatus,
      expectedUpdatedAt: args.task.updated_at,
      updatedAt,
      patch,
    });
  }
  logger.warn(
    {
      taskId: args.task.id,
      retryCount,
      delayMs,
      resumeAt: patch.resume_at,
      blockerClass: patch.last_blocker_class,
    },
    'Paused retryable paired failure until backoff elapses',
  );
  return true;
}
