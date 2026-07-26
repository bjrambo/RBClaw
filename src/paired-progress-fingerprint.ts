import { createHash } from 'crypto';

const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const RUN_ID_RE = /\b(?:runId|run_id|sessionId|session_id)=\S+/gi;
const TMP_PATH_RE = /\/tmp\/[^\s)>\]]+/g;

export function normalizeProgressEvidence(value: string | null): string {
  return (value ?? '')
    .replace(ISO_TIMESTAMP_RE, '<timestamp>')
    .replace(RUN_ID_RE, '<run-id>')
    .replace(TMP_PATH_RE, '<tmp-path>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildPairedProgressFingerprint(input: {
  taskId: string;
  workDir: string;
  currentSourceRef: string;
  approvedSourceRef: string | null;
  ownerVerdict: string | null;
  ownerOutput: string | null;
  reviewerVerdict: string | null;
  reviewerFeedback: string | null;
  blockerClass: string | null;
  externalWaitRef: string | null;
  verificationEvidence: string | null;
}): string {
  const canonical = JSON.stringify({
    approvedSourceRef: input.approvedSourceRef,
    blockerClass: input.blockerClass,
    currentSourceRef: input.currentSourceRef,
    externalWaitRef: input.externalWaitRef,
    ownerOutput: normalizeProgressEvidence(input.ownerOutput),
    ownerVerdict: input.ownerVerdict,
    reviewerFeedback: normalizeProgressEvidence(input.reviewerFeedback),
    reviewerVerdict: input.reviewerVerdict,
    taskId: input.taskId,
    verificationEvidence: normalizeProgressEvidence(input.verificationEvidence),
    workDir: input.workDir,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
