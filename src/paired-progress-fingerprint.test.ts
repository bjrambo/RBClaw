import { describe, expect, it } from 'vitest';

import {
  buildPairedProgressFingerprint,
  normalizeProgressEvidence,
} from './paired-progress-fingerprint.js';

describe('paired progress fingerprint', () => {
  it('ignores volatile timestamps, run ids, and temporary paths', () => {
    const first = normalizeProgressEvidence(
      'failed at 2026-07-27T01:00:00.000Z runId=abc /tmp/run-123/output.log',
    );
    const second = normalizeProgressEvidence(
      'failed at 2026-07-27T02:00:00.000Z runId=def /tmp/run-999/output.log',
    );
    expect(first).toBe(second);
  });

  it('is stable for the same semantic progress and changes with evidence', () => {
    const base = {
      taskId: 'task-1',
      workDir: '/workspace/project',
      currentSourceRef: 'workdir-v1:abc',
      approvedSourceRef: 'workdir-v1:before',
      ownerVerdict: 'step_done',
      ownerOutput: 'STEP_DONE\nsame result',
      reviewerVerdict: 'step_done',
      reviewerFeedback: 'STEP_DONE\nfix null handling',
      blockerClass: null,
      externalWaitRef: null,
      verificationEvidence: null,
    } as const;
    expect(buildPairedProgressFingerprint(base)).toBe(
      buildPairedProgressFingerprint({ ...base }),
    );
    expect(buildPairedProgressFingerprint(base)).not.toBe(
      buildPairedProgressFingerprint({
        ...base,
        ownerOutput: 'STEP_DONE\nnull handling fixed',
      }),
    );
  });
});
