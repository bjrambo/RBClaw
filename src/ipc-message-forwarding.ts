import type {
  IpcMessageForwardResult,
  IpcMessagePayload,
} from './ipc-types.js';
import { normalizeAgentOutput } from './agent-protocol.js';
import type { RegisteredGroup } from './types.js';

const VOICE_COMPANION_NONCE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const VOICE_COMPANION_MAX_AGE_MS = 5 * 60 * 1000;
const VOICE_COMPANION_MAX_FUTURE_SKEW_MS = 60 * 1000;
const HIGH_RISK_VOICE_PATTERNS = [
  /\bcommit\b/i,
  /\bpush\b/i,
  /\bdeploy\b/i,
  /\brestart\b/i,
  /\bssh\b/i,
  /\breset\b/i,
  /\brebase\b/i,
  /\bforce\b/i,
  /\brm\s+-/i,
  /\bdrop\s+(table|database)\b/i,
  /\bdelete\s+/i,
  /커밋/,
  /푸시/,
  /배포/,
  /재시작/,
  /리셋/,
  /리베이스/,
  /강제/,
  /삭제/,
  /지워/,
  /디비|DB|데이터베이스/i,
  /마이그레이션/,
  /SSH|접속/i,
];

function isVoiceCompanionMessage(msg: IpcMessagePayload): boolean {
  return msg.sourceKind === 'voice_companion';
}

function validateVoiceCompanionReplayFields(
  msg: IpcMessagePayload,
  now = Date.now(),
): boolean {
  if (!msg.nonce || !VOICE_COMPANION_NONCE_RE.test(msg.nonce)) return false;
  if (!msg.timestamp) return false;
  const timestampMs = Date.parse(msg.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (timestampMs < now - VOICE_COMPANION_MAX_AGE_MS) return false;
  if (timestampMs > now + VOICE_COMPANION_MAX_FUTURE_SKEW_MS) return false;
  return true;
}

function isHighRiskVoiceRequest(text: string): boolean {
  return HIGH_RISK_VOICE_PATTERNS.some((pattern) => pattern.test(text));
}

function hasLocalConfirmedHighRiskApproval(msg: IpcMessagePayload): boolean {
  return (
    msg.approvalLevel === 'high_risk_confirmed' &&
    msg.approvalMethod === 'local_confirm_click'
  );
}

function buildBlockedVoiceCompanionNotice(text: string): string {
  const preview = text.trim().slice(0, 500);
  return [
    '[voice_companion 차단]',
    '고위험 작업은 Companion의 Confirm 클릭 후 다시 보내야 합니다.',
    'approvalLevel=high_risk_confirmed 및 approvalMethod=local_confirm_click이 필요합니다.',
    '',
    `요청: ${preview}`,
  ].join('\n');
}

function buildVoiceCompanionMetadata(
  msg: IpcMessagePayload,
): string | undefined {
  if (!isVoiceCompanionMessage(msg)) return undefined;
  return JSON.stringify({
    source: 'voice_companion',
    nonce: msg.nonce ?? null,
    approvalLevel: msg.approvalLevel ?? 'none',
    approvalMethod: msg.approvalMethod ?? null,
    timestamp: msg.timestamp ?? null,
  });
}

export async function forwardAuthorizedIpcMessage(
  msg: IpcMessagePayload,
  sourceGroup: string,
  isMain: boolean,
  roomBindings: Record<string, RegisteredGroup>,
  sendMessage: (
    jid: string,
    text: string,
    senderRole?: string,
    runId?: string,
    attachments?: import('./types.js').OutboundAttachment[],
  ) => Promise<void>,
  injectInboundMessage?: (payload: {
    chatJid: string;
    text: string;
    sender?: string;
    senderName?: string;
    messageId?: string;
    timestamp?: string;
    treatAsHuman: boolean;
    sourceKind?: import('./types.js').MessageSourceKind;
    messageMetadata?: string | null;
  }) => Promise<void>,
): Promise<IpcMessageForwardResult> {
  if (
    !(
      (msg.type === 'message' || msg.type === 'inject_inbound_message') &&
      msg.chatJid &&
      msg.text
    )
  ) {
    return { outcome: 'ignored', senderRole: msg.senderRole ?? null };
  }

  const targetGroup = roomBindings[msg.chatJid];
  const isMainOverride = isMain === true;
  if (
    !(isMainOverride || (targetGroup && targetGroup.folder === sourceGroup))
  ) {
    return {
      outcome: 'blocked',
      chatJid: msg.chatJid,
      targetGroup: targetGroup?.folder ?? null,
      isMainOverride,
      senderRole: msg.senderRole ?? null,
    };
  }

  if (msg.type === 'inject_inbound_message') {
    if (!injectInboundMessage) {
      return {
        outcome: 'ignored',
        chatJid: msg.chatJid,
        targetGroup: targetGroup?.folder ?? null,
        isMainOverride,
        senderRole: msg.senderRole ?? null,
      };
    }
    if (isVoiceCompanionMessage(msg)) {
      if (!validateVoiceCompanionReplayFields(msg)) {
        return {
          outcome: 'blocked',
          chatJid: msg.chatJid,
          targetGroup: targetGroup?.folder ?? null,
          isMainOverride,
          senderRole: msg.senderRole ?? null,
        };
      }
      if (
        isHighRiskVoiceRequest(msg.text) &&
        !hasLocalConfirmedHighRiskApproval(msg)
      ) {
        await injectInboundMessage({
          chatJid: msg.chatJid,
          text: buildBlockedVoiceCompanionNotice(msg.text),
          sender: 'voice-companion-gate',
          senderName: 'Voice Companion Gate',
          messageId: `voice-blocked-${msg.nonce}`,
          timestamp: msg.timestamp,
          treatAsHuman: false,
          sourceKind: 'ipc_injected_bot',
          messageMetadata: JSON.stringify({
            source: 'voice_companion_gate',
            nonce: msg.nonce,
            blockedReason: 'high_risk_requires_dashboard_confirmation',
            timestamp: msg.timestamp ?? null,
          }),
        });
        return {
          outcome: 'sent',
          chatJid: msg.chatJid,
          targetGroup: targetGroup?.folder ?? null,
          isMainOverride,
          senderRole: msg.senderRole ?? null,
        };
      }
    }
    await injectInboundMessage({
      chatJid: msg.chatJid,
      text: msg.text,
      sender: msg.sender,
      senderName: msg.senderName,
      messageId:
        msg.messageId ||
        (isVoiceCompanionMessage(msg) ? `voice-${msg.nonce}` : undefined),
      timestamp: msg.timestamp,
      treatAsHuman: msg.treatAsHuman === true,
      sourceKind: msg.sourceKind,
      messageMetadata: buildVoiceCompanionMetadata(msg),
    });
    return {
      outcome: 'sent',
      chatJid: msg.chatJid,
      targetGroup: targetGroup?.folder ?? null,
      isMainOverride,
      senderRole: msg.senderRole ?? null,
    };
  }

  const normalized = normalizeAgentOutput(msg.text);
  if (normalized.output?.visibility === 'silent') {
    return {
      outcome: 'sent',
      chatJid: msg.chatJid,
      targetGroup: targetGroup?.folder ?? null,
      isMainOverride,
      senderRole: msg.senderRole ?? null,
    };
  }
  const structured =
    normalized.output?.visibility === 'public' ? normalized.output : null;
  const text = structured?.text ?? normalized.result ?? msg.text;
  const attachments =
    msg.attachments && msg.attachments.length > 0
      ? msg.attachments
      : (structured?.attachments ?? undefined);

  await sendMessage(msg.chatJid, text, msg.senderRole, msg.runId, attachments);
  return {
    outcome: 'sent',
    chatJid: msg.chatJid,
    targetGroup: targetGroup?.folder ?? null,
    isMainOverride,
    senderRole: msg.senderRole ?? null,
  };
}
