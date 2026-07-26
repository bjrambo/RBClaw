import { createHash } from 'crypto';

import type {
  ArbiterDirective,
  ArbiterDirectiveItem,
} from 'rbclaw-runners-shared';

function canonicalItem(item: ArbiterDirectiveItem): ArbiterDirectiveItem {
  return {
    action: item.action.trim(),
    id: item.id.trim(),
    scope: item.scope.trim(),
  };
}

function compareItems(
  left: ArbiterDirectiveItem,
  right: ArbiterDirectiveItem,
): number {
  return (
    left.id.localeCompare(right.id) ||
    left.scope.localeCompare(right.scope) ||
    left.action.localeCompare(right.action)
  );
}

export function canonicalizeArbiterDirective(
  directive: ArbiterDirective,
): string {
  return JSON.stringify({
    blockers: directive.blockers.map(canonicalItem).sort(compareItems),
    requirements: directive.requirements.map(canonicalItem).sort(compareItems),
    verdict: directive.verdict,
  });
}

export function fingerprintArbiterDirective(
  directive: ArbiterDirective,
): string {
  return createHash('sha256')
    .update(canonicalizeArbiterDirective(directive))
    .digest('hex');
}
