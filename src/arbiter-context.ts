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
    `For REVISE or RESET, put exactly one OWNER_ACTION line immediately after the verdict. For ESCALATE, use OWNER_ACTION: user-wait. Omit OWNER_ACTION for PROCEED.`,
    `After the verdict and optional OWNER_ACTION line, output exactly one fenced JSON object using the canonical rbclaw envelope shown below.`,
    `Do not omit the top-level "rbclaw" key.`,
    `Put the user-visible explanation in rbclaw.text without repeating the verdict line.`,
    `Do not write explanatory prose outside the verdict line, optional OWNER_ACTION line, and fenced JSON object.`,
    `arbiterDirective must contain the matching lowercase verdict plus requirements and blockers arrays of stable {id, scope, action} objects.`,
    `Do not put timestamps, run IDs, session IDs, or display-only prose in arbiterDirective.`,
    `<arbiter-output-example>`,
    `REVISE`,
    `OWNER_ACTION: file-edit`,
    '```json',
    `{`,
    `  "rbclaw": {`,
    `    "visibility": "public",`,
    `    "text": "Explain the required correction.",`,
    `    "arbiterDirective": {`,
    `      "verdict": "revise",`,
    `      "requirements": [`,
    `        {`,
    `          "id": "stable-requirement-id",`,
    `          "scope": "affected-scope",`,
    `          "action": "required-action"`,
    `        }`,
    `      ],`,
    `      "blockers": []`,
    `    }`,
    `  }`,
    `}`,
    '```',
    `</arbiter-output-example>`,
  ].join('\n');
}
