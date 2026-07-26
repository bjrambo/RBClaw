import { describe, expect, it } from 'vitest';

import {
  canonicalizeArbiterDirective,
  fingerprintArbiterDirective,
} from './paired-arbiter-directive.js';

describe('Arbiter directive canonicalization', () => {
  it('ignores requirement order and display-only fields', () => {
    const first = {
      verdict: 'revise' as const,
      requirements: [
        { id: 'b', scope: 'src/b.ts', action: 'fix-b' },
        { id: 'a', scope: 'src/a.ts', action: 'fix-a' },
      ],
      blockers: [],
    };
    const second = {
      verdict: 'revise' as const,
      requirements: [...first.requirements].reverse(),
      blockers: [],
    };

    expect(canonicalizeArbiterDirective(first)).toBe(
      canonicalizeArbiterDirective(second),
    );
    expect(fingerprintArbiterDirective(first)).toBe(
      fingerprintArbiterDirective(second),
    );
  });

  it('changes the fingerprint when a requirement changes', () => {
    const base = {
      verdict: 'revise' as const,
      requirements: [{ id: 'a', scope: 'src/a.ts', action: 'fix-a' }],
      blockers: [],
    };
    expect(fingerprintArbiterDirective(base)).not.toBe(
      fingerprintArbiterDirective({
        ...base,
        requirements: [
          { id: 'a', scope: 'src/a.ts', action: 'fix-null-input' },
        ],
      }),
    );
  });
});
