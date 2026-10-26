import {
  getLatestPairedTaskForChat,
  getPairedTaskById,
  getPairedTurnAttempts,
  getPairedTurnOutputs,
  getPairedTurnsForTask,
} from './db.js';
import { getEnv } from './env.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import type { OutboundAttachment, PairedRoomRole } from './types.js';

/** Explicit room opt-in; never enable another room as a side effect. */
export function isPairedFinalReportEnabled(chatJid: string): boolean {
  return (getEnv('RBCLAW_FINAL_DECISION_ROOMS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(chatJid);
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
The last task message must stand on its own, whether the owner or reviewer finishes.
For a question, state the answer, necessary reasons, and limitations briefly.
For implementation, state the final decision, actual changes, verification results,
authorized Git/deploy/restart actions actually performed, and remaining risks.
Do not finish with only "approved", "see above", or a reference to an earlier answer.
Do not invent evidence or perform extra work merely to write the report.
The existing review and completion rules still apply; do not request another turn
just to repeat a report. Review conclusions and caveats remain visible.`;

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
 * One existing output, not another model turn or another outbox entry. Preserve
 * the final reviewer's words and include the owner evidence they approved.
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
  const ownerOutput = [...getPairedTurnOutputs(task.id)]
    .reverse()
    .find(
      (output) =>
        output.task_id === task.id &&
        output.role === 'owner' &&
        output.turn_number > 0 &&
        output.output_text.trim(),
    );
  const sections = [reportPrefix(task.id)];
  if (ownerOutput) {
    sections.push('검토된 오너 작업 결과\n' + ownerOutput.output_text);
    if (ownerOutput.output_text.length >= 50_000) {
      sections.push(
        '주의: 저장된 오너 본문이 저장 한도에 도달해 원문 일부가 누락됐을 수 있습니다.',
      );
    }
  } else {
    sections.push(
      '주의: 이 과업의 오너 결과 원문을 찾지 못했습니다. 아래 검토 결론만 확인할 수 있습니다.',
    );
  }
  sections.push('최종 검토 결론\n' + input.text);

  const attachments = [
    ...(ownerOutput?.attachments ?? []),
    ...(input.attachments ?? []),
  ];
  const uniqueAttachments = attachments.filter(
    (attachment, index) =>
      attachments.findIndex((other) => other.path === attachment.path) ===
      index,
  );
  return {
    text: sections.join('\n\n'),
    pairedTaskId: task.id,
    attachments: uniqueAttachments.length ? uniqueAttachments : undefined,
  };
}
