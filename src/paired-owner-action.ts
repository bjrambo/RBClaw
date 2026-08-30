import {
  classifyArbiterVerdict,
  parseVisibleVerdict,
  resolveStoredVisibleVerdict,
} from './paired-verdict.js';
import { hasCodeChangesSinceRef } from './paired-source-ref.js';
import type { PairedTurnOutput } from './types.js';

export type OwnerRequiredAction =
  | 'file-edit'
  | 'verify'
  | 'explain'
  | 'user-wait'
  | 'unspecified';

const OWNER_ACTION_MARKER_RE =
  /^OWNER_ACTION\s*:\s*(file-edit|verify|explain|user-wait)\s*$/im;
const HOST_REJECTION_MARKER_RE =
  /^\[RBClaw owner evidence rejected; next-action=(file-edit|verify|explain|user-wait)\]$/im;

const NO_FILE_CHANGE_CLAIM_RE =
  /(?:파일|코드|소스)(?:은|는|을|를)?\s*(?:추가로\s*)?(?:수정|변경|편집)(?:하지\s*(?:않았|않음|않았습니다)|안\s*했|없(?:음|었))|(?:파일|코드|소스)\s*(?:변경|수정)\s*(?:0건|없음)|\b(?:no|without)\s+(?:file|code|source|worktree)\s+changes?\b|\b(?:files?|code|source)\s+(?:were\s+)?not\s+(?:modified|changed|edited)\b/i;

const FILE_CHANGE_CLAIM_RE =
  /(?:^|\n)\s*(?:상태\s*:\s*)?(?:구현|수정|변경|패치|적용)\s*(?:완료|됨|함)(?=\s|[.,!?:;]|$)|(?:파일|코드|소스)\s*\d+\s*개[^\n]*(?:수정|변경|추가)|(?:파일|코드|소스)(?:을|를)?\s*(?:수정|변경|추가)했(?:다|음|습니다)|\b(?:implementation|patch|code changes?)\s+(?:(?:is|are|was|were)\s+)?(?:complete|completed|applied)\b/i;

function parseOwnerActionMarker(
  outputText: string | null | undefined,
): OwnerRequiredAction | null {
  const match = outputText?.match(OWNER_ACTION_MARKER_RE);
  return (match?.[1] as OwnerRequiredAction | undefined) ?? null;
}

export function resolveOwnerRequiredAction(
  turnOutputs: readonly PairedTurnOutput[],
): OwnerRequiredAction {
  const latestOutput = turnOutputs.at(-1);
  if (!latestOutput) {
    return 'unspecified';
  }

  if (latestOutput.role === 'owner') {
    const rejectedAction = latestOutput.output_text.match(
      HOST_REJECTION_MARKER_RE,
    )?.[1] as OwnerRequiredAction | undefined;
    return rejectedAction ?? 'unspecified';
  }

  const explicitAction = parseOwnerActionMarker(latestOutput.output_text);
  if (explicitAction) {
    return explicitAction;
  }

  if (latestOutput.role === 'reviewer') {
    const verdict = resolveStoredVisibleVerdict({
      verdict: latestOutput.verdict,
      outputText: latestOutput.output_text,
    });
    if (
      verdict === 'step_done' ||
      verdict === 'done_with_concerns' ||
      verdict === 'continue'
    ) {
      return 'file-edit';
    }
    if (verdict === 'blocked' || verdict === 'needs_context') {
      return 'user-wait';
    }
    return 'unspecified';
  }

  const arbiterVerdict = classifyArbiterVerdict(latestOutput.output_text);
  if (arbiterVerdict === 'revise' || arbiterVerdict === 'reset') {
    return 'file-edit';
  }
  if (arbiterVerdict === 'escalate') {
    return 'user-wait';
  }
  return 'unspecified';
}

export interface OwnerCompletionEvidence {
  accepted: boolean;
  hasChangesThisTurn: boolean | null;
  hasTaskChanges: boolean | null;
  retryAction: Exclude<OwnerRequiredAction, 'unspecified'> | null;
  reason: string | null;
}

function completionCanRequireEvidence(outputText: string): boolean {
  const verdict = parseVisibleVerdict(outputText);
  return verdict !== 'blocked' && verdict !== 'needs_context';
}

export function assessOwnerCompletionEvidence(args: {
  workDir: string;
  turnSourceRef: string | null | undefined;
  taskSourceRef: string | null | undefined;
  requiredAction: OwnerRequiredAction;
  outputText: string;
}): OwnerCompletionEvidence {
  const hasChangesThisTurn = args.turnSourceRef
    ? hasCodeChangesSinceRef(args.workDir, args.turnSourceRef)
    : null;
  const hasTaskChanges = args.taskSourceRef
    ? hasCodeChangesSinceRef(args.workDir, args.taskSourceRef)
    : null;
  if (!completionCanRequireEvidence(args.outputText)) {
    return {
      accepted: true,
      hasChangesThisTurn,
      hasTaskChanges,
      retryAction: null,
      reason: null,
    };
  }

  if (args.requiredAction === 'file-edit' && hasChangesThisTurn === false) {
    return {
      accepted: false,
      hasChangesThisTurn,
      hasTaskChanges,
      retryAction: 'file-edit',
      reason: 'Required file-edit action completed without a worktree change.',
    };
  }

  const claimsNoChanges = NO_FILE_CHANGE_CLAIM_RE.test(args.outputText);
  const claimsChanges = FILE_CHANGE_CLAIM_RE.test(args.outputText);
  if (claimsNoChanges && claimsChanges) {
    return {
      accepted: false,
      hasChangesThisTurn,
      hasTaskChanges,
      retryAction: 'explain',
      reason: 'Owner report contradicted itself about whether files changed.',
    };
  }
  if ((!claimsNoChanges && !claimsChanges) || hasTaskChanges == null) {
    return {
      accepted: true,
      hasChangesThisTurn,
      hasTaskChanges,
      retryAction: null,
      reason: null,
    };
  }
  if (claimsChanges && hasTaskChanges === false) {
    return {
      accepted: false,
      hasChangesThisTurn,
      hasTaskChanges,
      retryAction: 'explain',
      reason: 'Owner reported file changes, but the worktree did not change.',
    };
  }
  if (claimsNoChanges && hasTaskChanges === true) {
    return {
      accepted: false,
      hasChangesThisTurn,
      hasTaskChanges,
      retryAction: 'explain',
      reason: 'Owner reported no file changes, but the worktree changed.',
    };
  }
  return {
    accepted: true,
    hasChangesThisTurn,
    hasTaskChanges,
    retryAction: null,
    reason: null,
  };
}

export function buildRejectedOwnerOutput(args: {
  outputText: string;
  reason: string;
  retryAction: Exclude<OwnerRequiredAction, 'unspecified'>;
}): string {
  return `[RBClaw owner evidence rejected; next-action=${args.retryAction}]\nReason: ${args.reason}\nThe following owner final was not delivered to the user:\n\n${args.outputText}`;
}

export function ownerActionPromptHint(
  action: OwnerRequiredAction,
): string | null {
  switch (action) {
    case 'file-edit':
      return 'Current required owner action: file-edit. Make the requested worktree change before reporting completion; analysis or verification alone does not complete this turn.';
    case 'verify':
      return 'Current required owner action: verify. Run the requested checks and report concrete evidence; do not edit files unless a verified defect requires it.';
    case 'explain':
      return 'Current required owner action: explain. Answer the requested question without making unrelated file changes.';
    case 'user-wait':
      return 'Current required owner action: user-wait. State the exact missing human decision or input and do not invent it.';
    case 'unspecified':
    default:
      return null;
  }
}
