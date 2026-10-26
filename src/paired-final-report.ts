import {
  getLatestPairedTaskForChat,
  getPairedTaskById,
  getPairedTurnAttempts,
  getPairedTurnsForTask,
} from './db.js';
import { getEnv } from './env.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import type {
  Channel,
  NewMessage,
  OutboundAttachment,
  PairedRoomRole,
  PairedTask,
} from './types.js';

/** Explicit room opt-in; never enable another room as a side effect. */
export function isPairedFinalReportEnabled(chatJid: string): boolean {
  return (getEnv('RBCLAW_FINAL_DECISION_ROOMS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(chatJid);
}

/** A published peer result is not a new request once its task has closed. */
export function filterTasklessPairedBotMessages(args: {
  chatJid: string;
  pairedRoom: boolean;
  task: PairedTask | null | undefined;
  messages: NewMessage[];
  channels: ReadonlyArray<Channel | null>;
}): NewMessage[] {
  if (
    args.task ||
    !args.pairedRoom ||
    !isPairedFinalReportEnabled(args.chatJid)
  ) {
    return args.messages;
  }
  return args.messages.filter(
    (message) =>
      message.message_source_kind === 'trusted_external_bot' ||
      !message.is_bot_message ||
      !args.channels.some(
        (channel) =>
          channel &&
          ['discord', 'discord-review', 'discord-arbiter'].includes(
            channel.name,
          ) &&
          channel.isOwnMessage?.(message),
      ),
  );
}

function reportPrefix(taskId: string): string {
  return `TASK_DONE — 최종 결정사항\n[과업 ${taskId}]\n\n`;
}

/** Persist the presentation in the existing work item, including on retries. */
export function isPairedFinalReportPayload(item: {
  paired_task_id?: string | null;
  result_payload: string;
}): boolean {
  return Boolean(
    item.paired_task_id &&
    item.result_payload.startsWith(reportPrefix(item.paired_task_id)),
  );
}

export const PAIRED_FINAL_REPORT_GUIDANCE = `Public final-report contract:
Keep owner, reviewer, and arbiter conversations, feedback, and approvals public.
Never expose hidden reasoning, credentials, or private tool results.
The owner provides the full, self-contained answer or implementation report.
For an owner answer to a question, state the answer, necessary reasons, and limitations briefly.
For an owner implementation report, state the final decision, actual changes, verification results,
authorized Git/deploy/restart actions actually performed, and remaining risks.
The final reviewer provides only the approval target, review conclusion, checks actually
performed, and remaining caveats. Do not repeat or reattach the owner report.
The owner report and final review stay as separate public messages.
Concrete defects still require rejection; never hide corrections or unverified items.
Do not invent evidence or perform extra work merely to write the report.
The existing review and completion rules still apply; do not request another turn
just to repeat a report or acknowledge final approval. Review conclusions and caveats remain visible.`;

interface FinalReportInput {
  chatJid: string;
  text: string;
  deliveryRole?: PairedRoomRole | null;
  pairedTaskId?: string | null;
  runId?: string;
  attachments?: OutboundAttachment[];
}

interface FinalReportOutput {
  text: string;
  pairedTaskId?: string | null;
  attachments?: OutboundAttachment[];
}

/**
 * Preserve the final reviewer's own output in the existing work item. The owner
 * report and evidence remain in the owner's public message, not in this approval.
 */
export function preparePairedFinalReport(
  input: FinalReportInput,
): FinalReportOutput {
  const original: FinalReportOutput = {
    text: input.text,
    pairedTaskId: input.pairedTaskId,
    attachments: input.attachments,
  };
  const verdict = parseVisibleVerdict(input.text);
  if (
    !isPairedFinalReportEnabled(input.chatJid) ||
    input.deliveryRole !== 'reviewer' ||
    (verdict !== 'done' && verdict !== 'task_done')
  ) {
    return original;
  }

  const latestTask = getLatestPairedTaskForChat(input.chatJid);
  const task = input.pairedTaskId
    ? getPairedTaskById(input.pairedTaskId)
    : latestTask;
  if (
    !task ||
    task.chat_jid !== input.chatJid ||
    latestTask?.id !== task.id ||
    (task.status === 'completed' && task.completion_reason !== 'done') ||
    task.review_phase !== 'final' ||
    !['review_ready', 'in_review', 'completed'].includes(task.status)
  ) {
    return original;
  }

  // Direct IPC must be tied to this task's actual running turn, not whichever
  // task happens to be latest when a delayed IPC file arrives.
  if (!input.pairedTaskId) {
    if (!input.runId) return original;
    const matchingRun = getPairedTurnsForTask(task.id).some(
      (turn) =>
        turn.role === input.deliveryRole &&
        getPairedTurnAttempts(turn.turn_id).some(
          (attempt) =>
            attempt.active_run_id === input.runId &&
            attempt.role === input.deliveryRole &&
            (attempt.state === 'running' || attempt.state === 'delegated'),
        ),
    );
    if (!matchingRun) return original;
  }

  if (input.text.startsWith(reportPrefix(task.id))) return original;
  const attachments = input.attachments ?? [];
  const uniqueAttachments = attachments.filter(
    (attachment, index) =>
      attachments.findIndex((other) => other.path === attachment.path) ===
      index,
  );
  return {
    text: reportPrefix(task.id) + input.text,
    pairedTaskId: task.id,
    attachments: uniqueAttachments.length ? uniqueAttachments : undefined,
  };
}
