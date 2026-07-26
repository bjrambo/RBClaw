import { getRecentChatMessages } from './db.js';
import { formatMessages } from './router.js';
import type { NewMessage } from './types.js';

export function buildArbiterContextPrompt(args: {
  chatJid: string;
  taskId: string;
  roundTripCount: number;
  timezone: string;
  recentTurnLimit?: number;
  /** Pre-labeled messages. If provided, skips DB fetch. */
  messages?: NewMessage[];
}): string {
  const {
    chatJid,
    taskId,
    roundTripCount,
    timezone,
    recentTurnLimit = 20,
  } = args;

  const recentMessages =
    args.messages ?? getRecentChatMessages(chatJid, recentTurnLimit);
  const conversationContext = formatMessages(recentMessages, timezone);

  return [
    `<arbiter-context>`,
    `<task-id>${taskId}</task-id>`,
    `<round-trips>${roundTripCount}</round-trips>`,
    `<reason>Deadlock detected: owner and reviewer exchanged ${roundTripCount} rounds without resolution</reason>`,
    `</arbiter-context>`,
    ``,
    `<conversation-history>`,
    conversationContext,
    `</conversation-history>`,
    ``,
    `Review the conversation above and render your verdict.`,
    `The first visible line must be exactly one of PROCEED, REVISE, RESET, or ESCALATE.`,
    `Also include one fenced JSON object with visibility="public", the same text, and an arbiterDirective object.`,
    `arbiterDirective must contain the matching lowercase verdict plus requirements and blockers arrays of stable {id, scope, action} objects.`,
    `Do not put timestamps, run IDs, session IDs, or display-only prose in arbiterDirective.`,
  ].join('\n');
}
