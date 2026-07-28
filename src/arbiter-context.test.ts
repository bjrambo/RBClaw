import { describe, expect, it } from 'vitest';
import { normalizeRbclawStructuredOutput } from 'rbclaw-runners-shared';

import { buildArbiterContextPrompt } from './arbiter-context.js';

describe('Arbiter context prompt', () => {
  it('does not mistake the observed root-level JSON for the canonical envelope', () => {
    const observedOutput = `ESCALATE
\`\`\`json
{
  "visibility": "public",
  "text": "User input is required.",
  "arbiterDirective": {
    "verdict": "escalate",
    "requirements": [],
    "blockers": []
  }
}
\`\`\``;

    expect(
      normalizeRbclawStructuredOutput(observedOutput).output,
    ).not.toHaveProperty('arbiterDirective');
  });

  it('provides a canonical structured output example accepted by the runner parser', () => {
    const prompt = buildArbiterContextPrompt({
      chatJid: 'dc:test-room',
      taskId: 'task-1',
      roundTripCount: 2,
      timezone: 'Asia/Seoul',
      messages: [],
    });
    const example = prompt.match(
      /<arbiter-output-example>\n([\s\S]+?)\n<\/arbiter-output-example>/,
    )?.[1];

    expect(example).toBeDefined();
    expect(normalizeRbclawStructuredOutput(example ?? '')).toMatchObject({
      result: 'REVISE\n\nExplain the required correction.',
      output: {
        visibility: 'public',
        text: 'REVISE\n\nExplain the required correction.',
        arbiterDirective: {
          verdict: 'revise',
          requirements: [
            {
              id: 'stable-requirement-id',
              scope: 'affected-scope',
              action: 'required-action',
            },
          ],
          blockers: [],
        },
      },
    });
    expect(prompt).toContain(
      'Do not write explanatory prose outside the fenced JSON object.',
    );
  });
});
