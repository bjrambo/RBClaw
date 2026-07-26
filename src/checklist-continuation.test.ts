import { describe, expect, it } from 'vitest';

import {
  advanceChecklistPlan,
  buildChecklistContinuationPrompt,
  createChecklistPlan,
  parseChecklistCommand,
  parseChecklistPlanNotes,
  serializeChecklistPlan,
} from './checklist-continuation.js';

describe('checklist continuation', () => {
  it('preserves legacy and malformed plan notes as freeform values', () => {
    expect(parseChecklistPlanNotes('legacy freeform note')).toBeNull();
    expect(parseChecklistPlanNotes('{"version":1}')).toBeNull();
  });

  it('parses a plan start command into ordered checklist items', () => {
    const command = parseChecklistCommand(
      '플랜 시작: 1) counter 분리 2) recovery 구현 3) dashboard 반영',
    );
    expect(command?.kind).toBe('start');
    if (command?.kind !== 'start') throw new Error('expected start command');
    expect(command.plan.items.map((item) => item.title)).toEqual([
      'counter 분리',
      'recovery 구현',
      'dashboard 반영',
    ]);
    expect(command.plan.items.map((item) => item.status)).toEqual([
      'in_progress',
      'pending',
      'pending',
    ]);
  });

  it('advances one step while preserving a stable versioned representation', () => {
    const plan = createChecklistPlan(['first', 'second']);
    const outcome = advanceChecklistPlan({
      plan,
      summary: 'first complete',
      changedFiles: ['b.ts', 'a.ts', 'a.ts'],
    });
    expect(outcome.kind).toBe('continue');
    expect(outcome.plan.currentIndex).toBe(1);
    expect(outcome.plan.items[0]).toMatchObject({
      status: 'done',
      summary: 'first complete',
      changedFiles: ['a.ts', 'b.ts'],
    });
    expect(outcome.plan.items[1].status).toBe('in_progress');
    expect(
      parseChecklistPlanNotes(serializeChecklistPlan(outcome.plan)),
    ).toEqual(outcome.plan);
    expect(
      buildChecklistContinuationPrompt(serializeChecklistPlan(outcome.plan)),
    ).toContain('현재 단계: second');
  });

  it('completes only after the final item', () => {
    const plan = createChecklistPlan(['only']);
    const outcome = advanceChecklistPlan({ plan, summary: 'done' });
    expect(outcome.kind).toBe('completed');
    expect(outcome.plan.items[0].status).toBe('done');
  });

  it('parks when the automatic continuation budget is exhausted', () => {
    const plan = createChecklistPlan(['one', 'two', 'three'], 1);
    const first = advanceChecklistPlan({ plan, summary: 'one done' });
    expect(first.kind).toBe('continue');
    const second = advanceChecklistPlan({
      plan: first.plan,
      summary: 'two done',
    });
    expect(second.kind).toBe('parked');
    expect(second.plan.currentIndex).toBe(2);
  });
});
