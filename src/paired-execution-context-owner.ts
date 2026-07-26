import {
  ARBITER_DEADLOCK_THRESHOLD,
  PAIRED_MAX_ARBITRATIONS,
  PAIRED_MAX_EPISODE_ROUND_TRIPS,
  PAIRED_STAGNATION_THRESHOLD,
} from './config.js';
import {
  getPairedTaskById,
  getPairedTurnOutputs,
  hasActiveCiWatcherForGoal,
} from './db.js';
import { resolveDirectWorkDir } from './direct-work-dir.js';
import { isTerminalCodexAccountFailure } from './agent-error-detection.js';
import { logger } from './logger.js';
import { requestArbiterOrEscalate } from './paired-arbiter-request.js';
import {
  applyPairedTaskPatch,
  transitionPairedTaskStatus,
} from './paired-task-status.js';
import { resolveOwnerCompletionSignal } from './paired-completion-signals.js';
import {
  hasCodeChangesSinceRef,
  resolveCanonicalSourceRef,
} from './paired-source-ref.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import { buildPairedProgressFingerprint } from './paired-progress-fingerprint.js';
import {
  advanceChecklistPlan,
  parseChecklistPlanNotes,
  serializeChecklistPlan,
} from './checklist-continuation.js';
import type { PairedTask } from './types.js';

type OwnerFinalizeOutcome = 'stop' | 're_review';
const OWNER_FAILURE_ESCALATION_THRESHOLD = 2;
const OWNER_CODEX_UNAVAILABLE_USER_ESCALATION_THRESHOLD = 4;
const EMPTY_STEP_DONE_THRESHOLD = 2;

interface OwnerProgressPatch {
  progress_fingerprint: string;
  stagnation_count: number;
  last_blocker_class: 'stagnation' | null;
}

function ownerFinalizeArbiterMessages(
  verdict: ReturnType<typeof parseVisibleVerdict>,
) {
  if (verdict === 'blocked' || verdict === 'needs_context') {
    return {
      request: 'Owner blocked during finalize — requesting arbiter',
      escalate: 'Owner blocked during finalize — escalating to user',
    };
  }
  if (verdict === 'done_with_concerns') {
    return {
      request: 'Owner finalize loop detected — requesting arbiter',
      escalate: 'Owner finalize loop detected — escalating to user',
    };
  }
  return {
    request: 'Owner finalize DONE loop detected — requesting arbiter',
    escalate: 'Owner finalize DONE loop detected — escalating to user',
  };
}

function resolveOwnerProgressPatch(args: {
  task: PairedTask;
  summary?: string | null;
}): OwnerProgressPatch {
  const reviewerOutput = [...getPairedTurnOutputs(args.task.id)]
    .reverse()
    .find((output) => output.role === 'reviewer');
  const currentSourceRef = resolveCanonicalSourceRef(
    resolveDirectWorkDir(args.task.work_dir),
  );
  const fingerprint = buildPairedProgressFingerprint({
    taskId: args.task.id,
    workDir: resolveDirectWorkDir(args.task.work_dir),
    currentSourceRef,
    approvedSourceRef: args.task.source_ref,
    ownerVerdict: parseVisibleVerdict(args.summary),
    ownerOutput: args.summary ?? null,
    reviewerVerdict: reviewerOutput?.verdict ?? null,
    reviewerFeedback: reviewerOutput?.output_text ?? null,
    blockerClass: args.task.last_blocker_class ?? null,
    externalWaitRef: args.task.external_wait_ref ?? null,
    verificationEvidence: null,
  });
  const stagnationCount =
    fingerprint === args.task.progress_fingerprint
      ? (args.task.stagnation_count ?? 0) + 1
      : 0;
  return {
    progress_fingerprint: fingerprint,
    stagnation_count: stagnationCount,
    last_blocker_class:
      stagnationCount >= PAIRED_STAGNATION_THRESHOLD ? 'stagnation' : null,
  };
}

export function handleFailedOwnerExecution(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();
  const nextFailureCount = (task.owner_failure_count ?? 0) + 1;
  if (isTerminalCodexAccountFailure(summary)) {
    if (nextFailureCount >= OWNER_CODEX_UNAVAILABLE_USER_ESCALATION_THRESHOLD) {
      transitionPairedTaskStatus({
        taskId,
        currentStatus: task.status,
        nextStatus: 'completed',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          owner_failure_count: nextFailureCount,
          arbiter_verdict: 'escalate',
          arbiter_requested_at: null,
          completion_reason: 'escalated',
        },
      });
      logger.warn(
        {
          taskId,
          role: 'owner',
          previousStatus: task.status,
          ownerFailureCount: nextFailureCount,
          summary: summary?.slice(0, 160),
        },
        'Escalated owner task after persistent Codex account failures',
      );
      return;
    }

    if (nextFailureCount >= OWNER_FAILURE_ESCALATION_THRESHOLD) {
      requestArbiterOrEscalate({
        taskId,
        currentStatus: task.status,
        expectedUpdatedAt: task.updated_at,
        now,
        arbiterLogMessage:
          'Owner Codex unavailable repeatedly — requesting arbiter',
        escalateLogMessage:
          'Owner Codex unavailable repeatedly — escalating to user',
        logContext: {
          taskId,
          role: 'owner',
          previousStatus: task.status,
          ownerFailureCount: nextFailureCount,
          summary: summary?.slice(0, 160),
        },
        patch: {
          owner_failure_count: nextFailureCount,
          arbiter_verdict: null,
          completion_reason: null,
        },
      });
      return;
    }

    const patch = {
      owner_failure_count: nextFailureCount,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
    };
    if (task.status === 'active' || task.status === 'merge_ready') {
      applyPairedTaskPatch({
        taskId,
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch,
      });
      logger.warn(
        {
          taskId,
          role: 'owner',
          status: task.status,
          ownerFailureCount: nextFailureCount,
          summary: summary?.slice(0, 200),
        },
        'Preserved owner task after terminal Codex account failure',
      );
      return;
    }

    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch,
    });
    logger.warn(
      {
        taskId,
        role: 'owner',
        status: task.status,
        ownerFailureCount: nextFailureCount,
        summary: summary?.slice(0, 200),
      },
      'Reset owner task to active after terminal Codex account failure',
    );
    return;
  }

  if (nextFailureCount >= OWNER_FAILURE_ESCALATION_THRESHOLD) {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage:
        'Owner failed repeatedly without a visible verdict — requesting arbiter',
      escalateLogMessage:
        'Owner failed repeatedly without a visible verdict — escalating to user',
      logContext: {
        taskId,
        role: 'owner',
        previousStatus: task.status,
        ownerFailureCount: nextFailureCount,
        summary: summary?.slice(0, 160),
      },
      patch: {
        owner_failure_count: nextFailureCount,
      },
    });
    return;
  }

  if (task.status !== 'active') {
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        owner_failure_count: nextFailureCount,
      },
    });
  } else {
    applyPairedTaskPatch({
      taskId,
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        owner_failure_count: nextFailureCount,
      },
    });
  }
  logger.info(
    {
      taskId,
      role: 'owner',
      previousStatus: task.status,
      ownerFailureCount: nextFailureCount,
      summary: summary?.slice(0, 160),
    },
    'Reset task to active after failed owner execution',
  );
}

function handleOwnerFinalizeCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
  now: string;
}): OwnerFinalizeOutcome {
  const { task, taskId, summary, now } = args;
  const ownerVerdict = parseVisibleVerdict(summary);
  const progressPatch = resolveOwnerProgressPatch({ task, summary });
  const hasNewChanges = hasCodeChangesSinceRef(
    resolveDirectWorkDir(task.work_dir),
    task.source_ref,
  );
  const nextFinalizeStepDoneCount =
    ownerVerdict === 'step_done'
      ? (task.finalize_step_done_count ?? 0) + 1
      : (task.finalize_step_done_count ?? 0);
  const nextEmptyStepDoneStreak =
    ownerVerdict === 'step_done' && hasNewChanges === false
      ? (task.empty_step_done_streak ?? 0) + 1
      : 0;
  const signal = resolveOwnerCompletionSignal({
    phase: 'finalize',
    visibleVerdict: ownerVerdict,
    hasChangesSinceApproval: hasNewChanges,
    roundTripCount: task.round_trip_count,
    deadlockThreshold: ARBITER_DEADLOCK_THRESHOLD,
  });

  if (signal.kind === 'request_arbiter') {
    const messages = ownerFinalizeArbiterMessages(ownerVerdict);
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage: messages.request,
      escalateLogMessage: messages.escalate,
      logContext: {
        taskId,
        ownerVerdict,
        roundTrips: task.round_trip_count,
        hasNewChanges,
        summary: summary?.slice(0, 100),
      },
      patch: {
        ...progressPatch,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: nextFinalizeStepDoneCount,
        empty_step_done_streak: nextEmptyStepDoneStreak,
      },
    });
    return 'stop';
  }

  if (
    ownerVerdict === 'step_done' &&
    hasNewChanges === false &&
    nextEmptyStepDoneStreak >= EMPTY_STEP_DONE_THRESHOLD
  ) {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage:
        'Owner repeated STEP_DONE during finalize without code changes — requesting arbiter',
      escalateLogMessage:
        'Owner repeated STEP_DONE during finalize without code changes — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        hasNewChanges,
        emptyStepDoneStreak: nextEmptyStepDoneStreak,
        finalizeStepDoneCount: nextFinalizeStepDoneCount,
        summary: summary?.slice(0, 100),
      },
      patch: {
        ...progressPatch,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: nextFinalizeStepDoneCount,
        empty_step_done_streak: nextEmptyStepDoneStreak,
      },
    });
    return 'stop';
  }

  if (signal.kind === 'request_reviewer') {
    if (signal.resetStatusToActive) {
      transitionPairedTaskStatus({
        taskId,
        currentStatus: task.status,
        nextStatus: 'active',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          ...progressPatch,
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: nextFinalizeStepDoneCount,
          empty_step_done_streak:
            ownerVerdict === 'step_done' ? nextEmptyStepDoneStreak : 0,
        },
      });
    }
    logger.info(
      {
        taskId,
        ownerVerdict,
        hasNewChanges,
        summary: summary?.slice(0, 100),
      },
      ownerVerdict === 'done_with_concerns'
        ? 'Owner raised concerns during finalize — task set back to active'
        : ownerVerdict === 'step_done'
          ? 'Owner reported STEP_DONE during finalize — task set back to active before review'
          : 'Owner made changes after reviewer approval — task set back to active before re-review',
    );
    maybeAutoTriggerReviewerAfterOwnerCompletion({
      task,
      taskId,
      now,
      logMessage:
        ownerVerdict === 'step_done'
          ? 'Auto-triggered reviewer after owner finalize STEP_DONE'
          : 'Auto-triggered reviewer after owner finalize required re-review',
      summary,
      patch:
        ownerVerdict === 'step_done'
          ? {
              finalize_step_done_count: nextFinalizeStepDoneCount,
              empty_step_done_streak: nextEmptyStepDoneStreak,
            }
          : undefined,
    });
    return 'stop';
  }

  const checklistFinalization = finalizeChecklistEpisode({
    task,
    taskId,
    summary,
    now,
    progressPatch,
    nextFinalizeStepDoneCount,
  });
  if (checklistFinalization.handled) {
    return 'stop';
  }
  task.plan_notes = checklistFinalization.planNotes;

  transitionPairedTaskStatus({
    taskId,
    currentStatus: task.status,
    nextStatus: 'completed',
    expectedUpdatedAt: task.updated_at,
    updatedAt: now,
    patch: {
      ...progressPatch,
      plan_notes: task.plan_notes,
      completion_reason: 'done',
      owner_failure_count: 0,
      owner_step_done_streak: 0,
      finalize_step_done_count: nextFinalizeStepDoneCount,
      empty_step_done_streak: 0,
    },
  });
  logger.info(
    { taskId, hasNewChanges, summary: summary?.slice(0, 100) },
    'Owner finalized after reviewer approval — task completed',
  );
  return 'stop';
}

function finalizeChecklistEpisode(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
  now: string;
  progressPatch: OwnerProgressPatch;
  nextFinalizeStepDoneCount: number;
}): { handled: boolean; planNotes: string | null } {
  const plan = parseChecklistPlanNotes(args.task.plan_notes);
  if (!plan) {
    return { handled: false, planNotes: args.task.plan_notes };
  }
  const outcome = advanceChecklistPlan({
    plan,
    summary: args.summary ?? 'Step completed.',
  });
  const planNotes = serializeChecklistPlan(outcome.plan);
  if (outcome.kind === 'completed') {
    return { handled: false, planNotes };
  }

  const supervisorState = outcome.kind === 'continue' ? 'runnable' : 'parked';
  transitionPairedTaskStatus({
    taskId: args.taskId,
    currentStatus: args.task.status,
    nextStatus: 'active',
    expectedUpdatedAt: args.task.updated_at,
    updatedAt: args.now,
    patch: {
      ...args.progressPatch,
      plan_notes: planNotes,
      episode_number: (args.task.episode_number ?? 1) + 1,
      round_trip_count: 0,
      total_round_trip_count:
        args.task.total_round_trip_count ?? args.task.round_trip_count,
      arbitration_count: args.task.arbitration_count ?? 0,
      supervisor_state: supervisorState,
      supervisor_state_changed_at: args.now,
      last_blocker_class: outcome.kind === 'parked' ? 'stagnation' : null,
      completion_reason: null,
      owner_failure_count: 0,
      owner_step_done_streak: 0,
      finalize_step_done_count: args.nextFinalizeStepDoneCount,
      empty_step_done_streak: 0,
    },
  });
  logger.info(
    {
      taskId: args.taskId,
      checklistStep: outcome.plan.currentIndex + 1,
      checklistItems: outcome.plan.items.length,
      supervisorState,
    },
    outcome.kind === 'continue'
      ? 'Advanced Checklist Plan to the next episode'
      : 'Parked Checklist Plan after reaching its automatic turn limit',
  );
  return { handled: true, planNotes };
}

function maybeAutoTriggerReviewerAfterOwnerCompletion(args: {
  task: PairedTask;
  taskId: string;
  now: string;
  logMessage: string;
  patch?: {
    owner_step_done_streak?: number;
    finalize_step_done_count?: number;
    empty_step_done_streak?: number;
    progress_fingerprint?: string | null;
    stagnation_count?: number;
    last_blocker_class?: 'stagnation' | null;
  };
  summary?: string | null;
}): void {
  const { task, taskId, now, logMessage } = args;
  const progressPatch =
    args.patch?.progress_fingerprint !== undefined
      ? {}
      : resolveOwnerProgressPatch({ task, summary: args.summary });
  const combinedPatch = { ...progressPatch, ...args.patch };
  const stagnationCount =
    combinedPatch.stagnation_count ?? task.stagnation_count ?? 0;
  if (
    stagnationCount >= PAIRED_STAGNATION_THRESHOLD ||
    task.round_trip_count >= PAIRED_MAX_EPISODE_ROUND_TRIPS
  ) {
    if ((task.arbitration_count ?? 0) < PAIRED_MAX_ARBITRATIONS) {
      requestArbiterOrEscalate({
        taskId,
        currentStatus: task.status,
        expectedUpdatedAt: task.updated_at,
        now,
        arbiterLogMessage:
          'Owner progress stalled or episode limit reached — requesting arbiter',
        escalateLogMessage:
          'Owner progress stalled or episode limit reached — escalating to user',
        patch: {
          ...combinedPatch,
          last_blocker_class: 'stagnation',
        },
      });
      return;
    }
    applyPairedTaskPatch({
      taskId,
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        ...combinedPatch,
        supervisor_state: 'waiting_user',
        supervisor_state_changed_at: now,
        last_blocker_class: 'stagnation',
      },
    });
    logger.warn(
      {
        taskId,
        arbitrationCount: task.arbitration_count ?? 0,
        stagnationCount,
      },
      'Paused paired Goal after reaching the automatic arbitration limit',
    );
    return;
  }

  const currentTask = getPairedTaskById(taskId);
  if (currentTask) {
    resolveDirectWorkDir(currentTask.work_dir);
    transitionPairedTaskStatus({
      taskId,
      currentStatus: currentTask.status,
      nextStatus: 'review_ready',
      expectedUpdatedAt: currentTask.updated_at,
      updatedAt: now,
      patch: { review_requested_at: now },
    });
    const reviewReadyTask = getPairedTaskById(taskId);
    if (!reviewReadyTask) {
      return;
    }
    applyPairedTaskPatch({
      taskId,
      expectedUpdatedAt: reviewReadyTask.updated_at,
      updatedAt: now,
      patch: {
        round_trip_count: task.round_trip_count + 1,
        total_round_trip_count:
          (task.total_round_trip_count ?? task.round_trip_count) + 1,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
        ...combinedPatch,
      },
    });
    if (hasActiveCiWatcherForGoal(task.chat_jid, task.id)) {
      logger.info(
        {
          taskId,
          chatJid: task.chat_jid,
          roundTrip: task.round_trip_count + 1,
        },
        'Active CI watcher found, marked task review_ready and deferred reviewer enqueue until watcher completes',
      );
      return;
    }
    logger.info({ taskId, roundTrip: task.round_trip_count + 1 }, logMessage);
  }
}

export function handleOwnerCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();

  if (task.status === 'merge_ready') {
    const finalizeOutcome = handleOwnerFinalizeCompletion({
      task,
      taskId,
      summary,
      now,
    });
    if (finalizeOutcome === 're_review') {
      maybeAutoTriggerReviewerAfterOwnerCompletion({
        task,
        taskId,
        now,
        logMessage:
          'Auto-triggered reviewer after owner finalize required re-review',
        summary,
      });
    }
    return;
  }

  const ownerVerdict = parseVisibleVerdict(summary);
  const progressPatch = resolveOwnerProgressPatch({ task, summary });
  const hasNewChanges = hasCodeChangesSinceRef(
    resolveDirectWorkDir(task.work_dir),
    task.source_ref,
  );
  const nextOwnerStepDoneStreak =
    ownerVerdict === 'step_done' ? (task.owner_step_done_streak ?? 0) + 1 : 0;
  const nextEmptyStepDoneStreak =
    ownerVerdict === 'step_done' && hasNewChanges === false
      ? (task.empty_step_done_streak ?? 0) + 1
      : 0;
  const signal = resolveOwnerCompletionSignal({
    phase: 'normal',
    visibleVerdict: ownerVerdict,
  });

  if (signal.kind === 'request_arbiter') {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage: 'Owner blocked/needs_context — requesting arbiter',
      escalateLogMessage: 'Owner blocked/needs_context — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        ownerStepDoneStreak: nextOwnerStepDoneStreak,
        summary: summary?.slice(0, 100),
      },
      patch: {
        ...progressPatch,
        owner_failure_count: 0,
        owner_step_done_streak: nextOwnerStepDoneStreak,
      },
    });
    return;
  }

  if (
    ownerVerdict === 'step_done' &&
    hasNewChanges === false &&
    nextEmptyStepDoneStreak >= EMPTY_STEP_DONE_THRESHOLD
  ) {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage:
        'Owner repeated STEP_DONE without code changes — requesting arbiter',
      escalateLogMessage:
        'Owner repeated STEP_DONE without code changes — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        hasNewChanges,
        ownerStepDoneStreak: nextOwnerStepDoneStreak,
        emptyStepDoneStreak: nextEmptyStepDoneStreak,
        summary: summary?.slice(0, 100),
      },
      patch: {
        ...progressPatch,
        owner_failure_count: 0,
        owner_step_done_streak: nextOwnerStepDoneStreak,
        empty_step_done_streak: nextEmptyStepDoneStreak,
      },
    });
    return;
  }

  maybeAutoTriggerReviewerAfterOwnerCompletion({
    task,
    taskId,
    now,
    logMessage: 'Auto-triggered reviewer after owner completion',
    summary,
    patch: {
      ...progressPatch,
      owner_step_done_streak: nextOwnerStepDoneStreak,
      empty_step_done_streak: nextEmptyStepDoneStreak,
    },
  });
}
