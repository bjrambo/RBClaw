import { logger } from './logger.js';
import { isTerminalCodexAccountFailure } from './agent-error-detection.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import { classifyArbiterVerdict } from './paired-verdict.js';
import {
  canonicalizeArbiterDirective,
  fingerprintArbiterDirective,
} from './paired-arbiter-directive.js';
import type { ArbiterDirective, PairedTask } from './types.js';

const ARBITER_RESOLUTION_ROUND_TRIP_COUNT = 0;

function buildNextEpisodePatch(
  task: PairedTask,
  supervisorState: 'runnable' | 'waiting_user',
) {
  const totalRoundTrips =
    task.total_round_trip_count ?? task.round_trip_count ?? 0;
  return {
    round_trip_count: ARBITER_RESOLUTION_ROUND_TRIP_COUNT,
    episode_number: (task.episode_number ?? 1) + 1,
    total_round_trip_count: totalRoundTrips,
    arbitration_count: task.arbitration_count ?? 0,
    stagnation_count: 0,
    supervisor_state: supervisorState,
    supervisor_state_changed_at: new Date().toISOString(),
    resume_at: null,
    external_wait_ref: null,
  } as const;
}

function handleArbiterProtocolGuard(args: {
  task: PairedTask;
  taskId: string;
  now: string;
  arbiterVerdict: ReturnType<typeof classifyArbiterVerdict>;
  arbiterDirective?: ArbiterDirective;
  protocolError?: 'arbiter-verdict-mismatch';
  directivePatch: {
    last_arbiter_directive_json: string | null;
    last_arbiter_directive_fingerprint: string | null;
  };
}): boolean {
  if (!args.arbiterDirective && !args.protocolError) {
    const protocolFailureCount = (args.task.owner_failure_count ?? 0) + 1;
    if (protocolFailureCount <= 1) {
      transitionPairedTaskStatus({
        taskId: args.taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'arbiter_requested',
        expectedUpdatedAt: args.task.updated_at,
        updatedAt: args.now,
        patch: {
          owner_failure_count: protocolFailureCount,
          last_blocker_class: 'protocol',
          arbiter_verdict: null,
          arbiter_requested_at: args.now,
        },
      });
      logger.warn(
        { taskId: args.taskId, protocolFailureCount },
        'Requested one Arbiter protocol correction because structured directive was missing',
      );
      return true;
    }
    transitionPairedTaskStatus({
      taskId: args.taskId,
      currentStatus: 'in_arbitration',
      nextStatus: 'active',
      expectedUpdatedAt: args.task.updated_at,
      updatedAt: args.now,
      patch: {
        ...buildNextEpisodePatch(args.task, 'waiting_user'),
        supervisor_state_changed_at: args.now,
        owner_failure_count: protocolFailureCount,
        last_blocker_class: 'protocol',
        arbiter_verdict: 'unknown',
        arbiter_requested_at: null,
      },
    });
    logger.warn(
      { taskId: args.taskId, protocolFailureCount },
      'Paused Goal after repeated Arbiter structured directive protocol failure',
    );
    return true;
  }

  if (
    !args.protocolError &&
    (!args.arbiterDirective ||
      args.arbiterDirective.verdict === args.arbiterVerdict)
  ) {
    return false;
  }
  transitionPairedTaskStatus({
    taskId: args.taskId,
    currentStatus: 'in_arbitration',
    nextStatus: 'active',
    expectedUpdatedAt: args.task.updated_at,
    updatedAt: args.now,
    patch: {
      ...buildNextEpisodePatch(args.task, 'waiting_user'),
      supervisor_state_changed_at: args.now,
      last_blocker_class: 'protocol',
      arbiter_verdict: 'unknown',
      arbiter_requested_at: null,
      ...args.directivePatch,
    },
  });
  logger.warn(
    {
      taskId: args.taskId,
      arbiterVerdict: args.arbiterVerdict,
      structuredVerdict: args.arbiterDirective?.verdict,
    },
    'Parked Arbiter result because visible and structured verdicts conflict',
  );
  return true;
}

function handleRepeatedArbiterDirective(args: {
  task: PairedTask;
  taskId: string;
  now: string;
  arbiterVerdict: ReturnType<typeof classifyArbiterVerdict>;
  directiveFingerprint: string | null;
  directivePatch: {
    last_arbiter_directive_json: string | null;
    last_arbiter_directive_fingerprint: string | null;
  };
}): boolean {
  if (
    !args.directiveFingerprint ||
    args.directiveFingerprint !==
      args.task.last_arbiter_directive_fingerprint ||
    (args.task.stagnation_count ?? 0) <= 0
  ) {
    return false;
  }
  transitionPairedTaskStatus({
    taskId: args.taskId,
    currentStatus: 'in_arbitration',
    nextStatus: 'active',
    expectedUpdatedAt: args.task.updated_at,
    updatedAt: args.now,
    patch: {
      ...buildNextEpisodePatch(args.task, 'waiting_user'),
      supervisor_state_changed_at: args.now,
      stagnation_count: args.task.stagnation_count ?? 0,
      last_blocker_class: 'stagnation',
      arbiter_verdict: args.arbiterVerdict,
      arbiter_requested_at: null,
      ...args.directivePatch,
    },
  });
  logger.warn(
    {
      taskId: args.taskId,
      directiveFingerprint: args.directiveFingerprint.slice(0, 12),
    },
    'Stopped automatic loop after repeated Arbiter directive without progress',
  );
  return true;
}

export function handleFailedArbiterExecution(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  if (isTerminalCodexAccountFailure(summary)) {
    const now = new Date().toISOString();
    const nextOwnerFailureCount = Math.max(
      (task.owner_failure_count ?? 0) + 1,
      1,
    );
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        owner_failure_count: nextOwnerFailureCount,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
      },
    });
    logger.warn(
      {
        taskId,
        role: 'arbiter',
        status: task.status,
        nextOwnerFailureCount,
        summary: summary?.slice(0, 200),
      },
      'Returned arbiter task to owner after terminal Codex account failure',
    );
    return;
  }
  const now = new Date().toISOString();
  const fallbackStatus =
    task.status === 'in_arbitration' || task.status === 'arbiter_requested'
      ? 'arbiter_requested'
      : task.status;
  if (fallbackStatus !== task.status) {
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: fallbackStatus,
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
    });
    logger.warn(
      {
        taskId,
        role: 'arbiter',
        previousStatus: task.status,
        nextStatus: fallbackStatus,
      },
      'Preserved arbiter task in arbitration-requested state after failed execution',
    );
  }
}

export function handleArbiterCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
  arbiterDirective?: ArbiterDirective;
  protocolError?: 'arbiter-verdict-mismatch';
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();
  const arbiterVerdict = classifyArbiterVerdict(summary);
  const directiveJson = args.arbiterDirective
    ? canonicalizeArbiterDirective(args.arbiterDirective)
    : null;
  const directiveFingerprint = args.arbiterDirective
    ? fingerprintArbiterDirective(args.arbiterDirective)
    : null;
  const directivePatch = {
    last_arbiter_directive_json: directiveJson,
    last_arbiter_directive_fingerprint: directiveFingerprint,
  };

  if (
    handleArbiterProtocolGuard({
      task,
      taskId,
      now,
      arbiterVerdict,
      arbiterDirective: args.arbiterDirective,
      protocolError: args.protocolError,
      directivePatch,
    })
  ) {
    return;
  }

  if (
    handleRepeatedArbiterDirective({
      task,
      taskId,
      now,
      arbiterVerdict,
      directiveFingerprint,
      directivePatch,
    })
  ) {
    return;
  }

  logger.info(
    { taskId, arbiterVerdict, summary: summary?.slice(0, 200) },
    'Arbiter verdict rendered',
  );

  switch (arbiterVerdict) {
    case 'proceed':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'review_ready',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          ...buildNextEpisodePatch(task, 'runnable'),
          supervisor_state_changed_at: now,
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: 0,
          empty_step_done_streak: 0,
          arbiter_verdict: arbiterVerdict,
          arbiter_requested_at: null,
          ...directivePatch,
        },
      });
      logger.info(
        { taskId, arbiterVerdict },
        'Arbiter proceeded — returning task to reviewer for approval',
      );
      return;
    case 'revise':
    case 'reset':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'active',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          ...buildNextEpisodePatch(task, 'runnable'),
          supervisor_state_changed_at: now,
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: 0,
          empty_step_done_streak: 0,
          arbiter_verdict: arbiterVerdict,
          arbiter_requested_at: null,
          ...directivePatch,
        },
      });
      logger.info(
        { taskId, arbiterVerdict },
        'Arbiter requested owner changes — resuming owner flow',
      );
      return;
    case 'escalate':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'active',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          ...buildNextEpisodePatch(task, 'waiting_user'),
          supervisor_state_changed_at: now,
          last_blocker_class: 'user_input',
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: 0,
          empty_step_done_streak: 0,
          arbiter_verdict: 'escalate',
          arbiter_requested_at: null,
          completion_reason: null,
          ...directivePatch,
        },
      });
      logger.info(
        { taskId },
        'Arbiter escalated to user — task left active awaiting human input',
      );
      return;
    default:
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'completed',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          arbiter_verdict: 'unknown',
          completion_reason: 'arbiter_escalated',
          ...directivePatch,
        },
      });
      logger.warn(
        { taskId, summary: summary?.slice(0, 200) },
        'Arbiter verdict unrecognized — escalating instead of treating it as approval',
      );
      return;
  }
}
