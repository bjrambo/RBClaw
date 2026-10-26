import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getLatestPairedTaskForChat: vi.fn(),
  getPairedTaskById: vi.fn(),
  getPairedTurnOutputs: vi.fn(),
  getPairedTurnsForTask: vi.fn(),
  getPairedTurnAttempts: vi.fn(),
  createProducedWorkItem: vi.fn(),
}));

vi.mock('./message-runtime-delivery.js', () => ({
  deliverOpenWorkItem: vi.fn(async () => true),
}));

import * as db from './db.js';
import { deliverIpcOutboundMessage } from './ipc-outbound-delivery.js';
import { deliverMessageRuntimeFinalText } from './message-runtime-final-delivery.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import {
  isPairedFinalReportEnabled,
  isPairedFinalReportPayload,
  preparePairedFinalReport,
} from './paired-final-report.js';
import {
  buildFinalizePendingPrompt,
  buildReviewerPendingPrompt,
} from './message-runtime-prompts.js';

const task = {
  id: 'task-final',
  chat_jid: 'dc:enabled',
  review_phase: 'final',
  status: 'in_review',
  completion_reason: null,
};
const input = {
  chatJid: 'dc:enabled',
  pairedTaskId: task.id,
  deliveryRole: 'reviewer' as const,
  text: 'TASK_DONE\n최종 승인. 배포는 이번 범위에 포함되지 않았습니다.',
};
const owner = {
  task_id: task.id,
  turn_number: 3,
  role: 'owner',
  output_text:
    'TASK_DONE\n설정 오류 수정. 테스트 11건 통과. 운영 배포는 하지 않았습니다.',
  attachments: [{ path: '/evidence/result.txt', name: 'result.txt' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('RBCLAW_FINAL_DECISION_ROOMS', 'dc:enabled, dc:second');
  vi.mocked(db.getPairedTaskById).mockReturnValue(task as any);
  vi.mocked(db.getLatestPairedTaskForChat).mockReturnValue(task as any);
  vi.mocked(db.getPairedTurnOutputs).mockReturnValue([owner] as any);
});
afterEach(() => vi.unstubAllEnvs());

describe('room-scoped final decision reports', () => {
  it('is explicitly opt-in and preserves other rooms byte-for-byte', () => {
    expect(isPairedFinalReportEnabled('dc:enabled')).toBe(true);
    expect(isPairedFinalReportEnabled('dc:second')).toBe(true);
    expect(isPairedFinalReportEnabled('dc:other')).toBe(false);
    const other = preparePairedFinalReport({ ...input, chatJid: 'dc:other' });
    expect(other.text).toBe(input.text);
    expect(db.getPairedTaskById).not.toHaveBeenCalled();
    vi.stubEnv('RBCLAW_FINAL_DECISION_ROOMS', '');
    expect(preparePairedFinalReport(input).text).toBe(input.text);
  });

  it.each(['TASK_DONE', 'DONE', 'Approved'])(
    'publishes only the visible reviewer conclusion for %s',
    (verdict) => {
      const text = verdict + '\n최종 승인. 미검증 사항은 실제 마이크입니다.';
      const report = preparePairedFinalReport({ ...input, text });
      expect(report.text).not.toContain(owner.output_text);
      expect(report.text).toContain(text);
      expect(report.text).toContain('최종 결정사항');
      expect(report.attachments).toBeUndefined();
      expect(db.getPairedTurnOutputs).not.toHaveBeenCalled();
      expect(
        isPairedFinalReportPayload({
          paired_task_id: task.id,
          result_payload: report.text,
        }),
      ).toBe(true);
      expect(
        isPairedFinalReportPayload({
          paired_task_id: 'other',
          result_payload: report.text,
        }),
      ).toBe(false);
    },
  );

  it('preserves owner finalization verbatim before final review', () => {
    const ownerTask = {
      ...task,
      status: 'merge_ready',
      review_phase: 'implementation',
    };
    vi.mocked(db.getPairedTaskById).mockReturnValue(ownerTask as any);
    const report = preparePairedFinalReport({
      ...input,
      deliveryRole: 'owner',
      text: owner.output_text,
      attachments: owner.attachments,
    });
    expect(report.text).toBe(owner.output_text);
    expect(report.attachments).toEqual(owner.attachments);
    expect(report.text).not.toContain('최종 결정사항');
    expect(db.getPairedTaskById).not.toHaveBeenCalled();
    expect(db.getPairedTurnOutputs).not.toHaveBeenCalled();
    expect(report.pairedTaskId).toBe(task.id);
  });

  it.each(['STEP_DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'])(
    'does not relabel %s feedback as final approval',
    (verdict) => {
      const text = verdict + '\n아직 해결할 사항이 있습니다.';
      expect(preparePairedFinalReport({ ...input, text }).text).toBe(text);
    },
  );

  it('does not turn implementation approval into task completion', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      ...task,
      review_phase: 'implementation',
    } as any);
    expect(preparePairedFinalReport(input).text).toBe(input.text);
  });

  it.each(['stopped', 'superseded', 'escalated', 'arbiter_escalated'])(
    'never labels a %s task as a successful final report',
    (completion_reason) => {
      vi.mocked(db.getPairedTaskById).mockReturnValue({
        ...task,
        status: 'completed',
        completion_reason,
      } as any);
      expect(preparePairedFinalReport(input).text).toBe(input.text);
    },
  );

  it('never mixes the previous task or carried-forward output into a new report', () => {
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      { ...owner, task_id: 'previous', output_text: '이전 과업 배포' },
      { ...owner, turn_number: 0, output_text: 'carried-forward' },
    ] as any);
    const result = preparePairedFinalReport(input);
    expect(result.text).not.toContain('이전 과업 배포');
    expect(result.text).not.toContain('carried-forward');
    expect(result.text).toContain(input.text);
    expect(result.text).not.toContain('오너 결과 원문을 찾지 못했습니다');
    expect(db.getPairedTurnOutputs).not.toHaveBeenCalled();
    vi.mocked(db.getLatestPairedTaskForChat).mockReturnValue({
      ...task,
      id: 'new-task',
    } as any);
    expect(preparePairedFinalReport(input).text).toBe(input.text);
  });

  it('preserves reviewer caveats and their own evidence without owner attachments', () => {
    const reviewerAttachments = [
      { path: '/evidence/review.txt', name: 'review.txt' },
    ];
    const report = preparePairedFinalReport({
      ...input,
      attachments: reviewerAttachments,
    });
    expect(report.attachments).toEqual(reviewerAttachments);
    expect(report.attachments).not.toContainEqual(owner.attachments[0]);
    expect(report.text).toContain('배포는 이번 범위에 포함되지 않았습니다');
    expect(report.text).not.toContain(owner.output_text);
  });

  it('keeps existing de-duplication for the reviewer evidence itself', () => {
    const evidence = { path: '/evidence/review.txt', name: 'review.txt' };
    const report = preparePairedFinalReport({
      ...input,
      attachments: [evidence, { ...evidence }],
    });
    expect(report.attachments).toEqual([evidence]);
    expect(
      preparePairedFinalReport({ ...input, attachments: [] }).attachments,
    ).toBeUndefined();
  });

  it('does not load or duplicate a long owner report in a short final approval', () => {
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      { ...owner, output_text: '가'.repeat(50_000) },
    ] as any);
    const report = preparePairedFinalReport(input);
    expect(report.text).toContain(input.text);
    expect(report.text).not.toContain('가'.repeat(100));
    expect(report.text).not.toContain('원문 일부가 누락됐을 수 있습니다');
    expect(report.text.length).toBeLessThan(200);
    expect(db.getPairedTurnOutputs).not.toHaveBeenCalled();
  });

  it('preserves prepared approval text and evidence when delivery is retried', () => {
    const attachments = [{ path: '/evidence/review.txt', name: 'review.txt' }];
    const report = preparePairedFinalReport({ ...input, attachments });
    expect(
      preparePairedFinalReport({ ...input, text: report.text, attachments }),
    ).toEqual(report);
    expect(report.text.match(/최종 결정사항/g)).toHaveLength(1);
    expect(report.attachments).toEqual(attachments);
    expect(db.getPairedTurnOutputs).not.toHaveBeenCalled();
  });

  it('requires a matching running task attempt for direct IPC reports', () => {
    const ipc = { ...input, pairedTaskId: undefined, runId: 'run-final' };
    vi.mocked(db.getPairedTurnsForTask).mockReturnValue([
      { turn_id: 'turn-final', role: 'reviewer' },
    ] as any);
    vi.mocked(db.getPairedTurnAttempts).mockReturnValue([
      { active_run_id: 'run-final', role: 'reviewer', state: 'running' },
    ] as any);
    const report = preparePairedFinalReport(ipc);
    expect(report.text).toContain('[과업 task-final]');
    expect(report.text).toContain(input.text);
    expect(report.text).not.toContain(owner.output_text);
    expect(preparePairedFinalReport({ ...ipc, runId: 'stale-run' }).text).toBe(
      input.text,
    );
    expect(preparePairedFinalReport({ ...ipc, runId: undefined }).text).toBe(
      input.text,
    );
  });

  it('keeps owner output unchanged after transitioning to final review', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      ...task,
      status: 'review_ready',
    } as any);
    const report = preparePairedFinalReport({
      ...input,
      deliveryRole: 'owner',
      text: owner.output_text,
      attachments: owner.attachments,
    });
    expect(report.text).toBe(owner.output_text);
    expect(report.attachments).toEqual(owner.attachments);
    expect(report.text).not.toContain('최종 결정사항');
    expect(db.getPairedTurnOutputs).not.toHaveBeenCalled();
  });

  it('delivers only reviewer approval through terminal IPC without an extra queue item', async () => {
    vi.mocked(db.getPairedTurnsForTask).mockReturnValue([
      { turn_id: 'turn-final', role: 'reviewer' },
    ] as any);
    vi.mocked(db.getPairedTurnAttempts).mockReturnValue([
      { active_run_id: 'run-final', role: 'reviewer', state: 'running' },
    ] as any);
    const makeChannel = (name: string) => ({
      name,
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: () => true,
      ownsJid: () => name === 'discord',
    });
    const createWorkItem = vi.fn(
      (args) => ({ ...args, id: 1, delivery_attempts: 0 }) as any,
    );
    const deliverWorkItem = vi.fn(async () => true);
    const noteDirectTerminalDelivery = vi.fn();
    await expect(
      deliverIpcOutboundMessage(
        {
          jid: input.chatJid,
          text: input.text,
          senderRole: 'reviewer',
          runId: 'run-final',
        },
        {
          channels: [makeChannel('discord'), makeChannel('discord-review')],
          roomBindings: () => ({
            [input.chatJid]: {
              name: 'Room',
              folder: 'room',
              added_at: '2026-10-26',
              agentType: 'codex',
            },
          }),
          queue: { noteDirectTerminalDelivery },
          createWorkItem,
          deliverWorkItem,
        },
      ),
    ).resolves.toBe('delivered');
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect(createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_role: 'reviewer',
        paired_task_id: task.id,
        result_payload: expect.stringContaining(input.text),
      }),
    );
    expect(createWorkItem.mock.calls[0][0].result_payload).toContain(
      input.text,
    );
    expect(createWorkItem.mock.calls[0][0].result_payload).not.toContain(
      owner.output_text,
    );
    expect(createWorkItem.mock.calls[0][0].attachments).toBeUndefined();
    expect(noteDirectTerminalDelivery).toHaveBeenCalledWith(
      input.chatJid,
      'reviewer',
      input.text,
    );
  });

  it('persists the reviewer-only SDK final once without changing its speaker or task', async () => {
    vi.mocked(db.createProducedWorkItem).mockImplementation(
      (args) => ({ ...args, id: 5, delivery_attempts: 0 }) as any,
    );
    vi.mocked(deliverOpenWorkItem).mockResolvedValue(true);
    const channel = {
      name: 'discord-review',
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: () => true,
      ownsJid: () => false,
    };
    await expect(
      deliverMessageRuntimeFinalText({
        ...input,
        runId: 'run-sdk',
        channel,
        group: { name: 'Room', folder: 'room', added_at: '2026-10-26' },
        startSeq: 1,
        endSeq: 2,
        deliveryServiceId: 'claude',
        isDuplicateOfLastBotFinal: () => true,
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(db.createProducedWorkItem).toHaveBeenCalledTimes(1);
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_role: 'reviewer',
        paired_task_id: task.id,
        result_payload: expect.stringContaining(input.text),
      }),
    );
    expect(deliverOpenWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        channel,
        item: expect.objectContaining({
          result_payload: expect.stringContaining(input.text),
        }),
      }),
    );
    const saved = vi.mocked(db.createProducedWorkItem).mock.calls[0][0];
    expect(saved.result_payload).not.toContain(owner.output_text);
    expect(saved.attachments).toBeUndefined();
  });

  it('also renders a final approval recovered after execution failure', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      ...task,
      status: 'completed',
      completion_reason: 'done',
    } as any);
    const report = preparePairedFinalReport(input);
    expect(report.text).toContain(input.text);
    expect(report.text).not.toContain(owner.output_text);
  });

  it('assigns the full answer to the owner and concise approval to the final reviewer', () => {
    const base = { turnOutputs: [], recentHumanMessages: [] };
    const ownerPrompt = buildFinalizePendingPrompt({
      ...base,
      chatJid: 'dc:enabled',
    });
    expect(ownerPrompt).toContain('Public final-report contract');
    expect(ownerPrompt).toContain(
      'Keep owner, reviewer, and arbiter conversations',
    );
    expect(ownerPrompt).toContain(
      'The owner provides the full, self-contained answer or implementation report.',
    );
    expect(
      buildFinalizePendingPrompt({ ...base, chatJid: 'dc:other' }),
    ).not.toContain('Public final-report contract');
    const reviewer = {
      ...base,
      chatJid: 'dc:enabled',
      timezone: 'UTC',
      lastHumanMessage: null,
      reviewPhase: 'final' as const,
    };
    const reviewerPrompt = buildReviewerPendingPrompt(reviewer);
    expect(reviewerPrompt).toContain(
      'Keep final approval brief: identify the owner result being approved',
    );
    expect(reviewerPrompt).toContain(
      'Do not repeat or reattach the owner report',
    );
    expect(reviewerPrompt).toContain(
      'Concrete defects still require rejection',
    );
    expect(reviewerPrompt).not.toContain(
      'The runtime combines the owner result and attachments',
    );
    expect(reviewerPrompt).not.toContain(
      'The last task message must stand on its own',
    );
    expect(
      buildReviewerPendingPrompt({
        ...reviewer,
        reviewPhase: 'implementation',
      }),
    ).not.toContain('Public final-report contract');
  });
});
