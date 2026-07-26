export type ChecklistItemStatus = 'pending' | 'in_progress' | 'done';

export interface ChecklistPlanItem {
  id: string;
  title: string;
  status: ChecklistItemStatus;
  summary?: string;
  changedFiles?: string[];
}

export interface ChecklistPlan {
  version: 1;
  mode: 'planned';
  items: ChecklistPlanItem[];
  currentIndex: number;
  autoContinueOnDone: boolean;
  maxAutoTurns: number;
  autoTurnsUsed: number;
  lastStepSummary?: string;
}

export type ChecklistCommand =
  | { kind: 'start'; plan: ChecklistPlan }
  | { kind: 'status' }
  | { kind: 'stop' };

const DEFAULT_MAX_AUTO_TURNS = 6;

function isChecklistItem(value: unknown): value is ChecklistPlanItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ChecklistPlanItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    (item.status === 'pending' ||
      item.status === 'in_progress' ||
      item.status === 'done') &&
    (item.summary === undefined || typeof item.summary === 'string') &&
    (item.changedFiles === undefined ||
      (Array.isArray(item.changedFiles) &&
        item.changedFiles.every((entry) => typeof entry === 'string')))
  );
}

export function parseChecklistPlanNotes(
  value: string | null | undefined,
): ChecklistPlan | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ChecklistPlan>;
    if (
      parsed.version !== 1 ||
      parsed.mode !== 'planned' ||
      !Array.isArray(parsed.items) ||
      parsed.items.length === 0 ||
      !parsed.items.every(isChecklistItem) ||
      !Number.isInteger(parsed.currentIndex) ||
      parsed.currentIndex! < 0 ||
      parsed.currentIndex! >= parsed.items.length ||
      typeof parsed.autoContinueOnDone !== 'boolean' ||
      !Number.isInteger(parsed.maxAutoTurns) ||
      parsed.maxAutoTurns! < 1 ||
      !Number.isInteger(parsed.autoTurnsUsed) ||
      parsed.autoTurnsUsed! < 0
    ) {
      return null;
    }
    return parsed as ChecklistPlan;
  } catch {
    return null;
  }
}

export function serializeChecklistPlan(plan: ChecklistPlan): string {
  return JSON.stringify(plan);
}

function parseChecklistTitles(value: string): string[] {
  const normalized = value.replace(/\r/g, '\n').trim();
  if (!normalized) return [];
  const matches = [
    ...normalized.matchAll(
      /(?:^|\n|\s)(?:\d+[.)]|[-*])\s*([\s\S]*?)(?=(?:\n|\s)(?:\d+[.)]|[-*])\s|$)/g,
    ),
  ];
  const titles = matches
    .map((match) => match[1].trim())
    .filter((title) => title.length > 0);
  return titles.length > 0
    ? titles
    : normalized
        .split(/\s*;\s*|\n+/)
        .map((title) => title.trim())
        .filter(Boolean);
}

export function createChecklistPlan(
  titles: string[],
  maxAutoTurns = DEFAULT_MAX_AUTO_TURNS,
): ChecklistPlan {
  if (titles.length === 0) {
    throw new Error('Checklist plan requires at least one item');
  }
  return {
    version: 1,
    mode: 'planned',
    items: titles.map((title, index) => ({
      id: `step-${index + 1}`,
      title,
      status: index === 0 ? 'in_progress' : 'pending',
    })),
    currentIndex: 0,
    autoContinueOnDone: true,
    maxAutoTurns: Math.max(1, Math.trunc(maxAutoTurns)),
    autoTurnsUsed: 0,
  };
}

export function parseChecklistCommand(text: string): ChecklistCommand | null {
  const trimmed = text.trim();
  const startMatch = /^플랜\s*시작\s*:\s*([\s\S]+)$/i.exec(trimmed);
  if (startMatch) {
    const titles = parseChecklistTitles(startMatch[1]);
    return titles.length > 0
      ? { kind: 'start', plan: createChecklistPlan(titles) }
      : null;
  }
  if (/^플랜\s*상태$/i.test(trimmed)) return { kind: 'status' };
  if (/^플랜\s*중지$/i.test(trimmed)) return { kind: 'stop' };
  return null;
}

export function hasChecklistContinuation(
  planNotes: string | null | undefined,
): boolean {
  const plan = parseChecklistPlanNotes(planNotes);
  return (
    plan !== null &&
    plan.autoContinueOnDone &&
    plan.currentIndex < plan.items.length &&
    plan.items[plan.currentIndex]?.status === 'in_progress'
  );
}

export function advanceChecklistPlan(args: {
  plan: ChecklistPlan;
  summary: string;
  changedFiles?: string[];
}):
  | { kind: 'completed'; plan: ChecklistPlan }
  | { kind: 'continue'; plan: ChecklistPlan }
  | { kind: 'parked'; plan: ChecklistPlan } {
  const plan = structuredClone(args.plan);
  const current = plan.items[plan.currentIndex];
  if (!current) return { kind: 'completed', plan };

  current.status = 'done';
  current.summary = args.summary.trim().slice(0, 1000);
  current.changedFiles = [...new Set(args.changedFiles ?? [])].sort();
  plan.lastStepSummary = current.summary;

  const nextIndex = plan.currentIndex + 1;
  if (nextIndex >= plan.items.length) {
    return { kind: 'completed', plan };
  }

  plan.currentIndex = nextIndex;
  plan.items[nextIndex].status = 'in_progress';
  plan.autoTurnsUsed += 1;
  if (!plan.autoContinueOnDone || plan.autoTurnsUsed > plan.maxAutoTurns) {
    return { kind: 'parked', plan };
  }
  return { kind: 'continue', plan };
}

export function buildChecklistContinuationPrompt(
  planNotes: string | null | undefined,
): string | null {
  const plan = parseChecklistPlanNotes(planNotes);
  if (!plan) return null;
  const current = plan.items[plan.currentIndex];
  if (!current || current.status !== 'in_progress') return null;
  const remaining = plan.items
    .slice(plan.currentIndex + 1)
    .filter((item) => item.status === 'pending')
    .map((item) => `- ${item.title}`)
    .join('\n');
  return [
    '[Checklist Continuation]',
    `현재 단계: ${current.title}`,
    plan.lastStepSummary ? `직전 단계 요약: ${plan.lastStepSummary}` : null,
    remaining ? `남은 단계:\n${remaining}` : null,
    `자동 진행: ${plan.autoTurnsUsed}/${plan.maxAutoTurns}`,
    '현재 단계만 구현·검증하고 완료 상태를 보고하라.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
