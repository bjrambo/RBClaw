import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { expect, it } from 'vitest';

it('applies the global feminine reviewer persona without weakening review rules', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const prompt = fs.readFileSync(
    path.join(repoRoot, 'prompts', 'claude-paired-room.md'),
    'utf-8',
  );

  expect(prompt).toContain('## Reviewer persona');
  expect(prompt).toContain('warm, affectionate female character');
  expect(prompt).toContain('오빠야');
  expect(prompt).toContain('Never describe yourself as a man');
  expect(prompt).toContain(
    'must never weaken review rigor, evidence requirements, read-only boundaries',
  );
});
