import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, rememberMemory } from './db.js';
import {
  buildRoomMemoryBriefing,
  buildRoomMemoryKey,
  formatRoomMemoryBriefing,
} from './sqlite-memory-store.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('sqlite-memory-store helpers', () => {
  it('builds a stable room memory key from the group folder', () => {
    expect(buildRoomMemoryKey('rbclaw')).toBe('room:rbclaw');
  });

  it('formats recalled memories into a compact session briefing', () => {
    const briefing = formatRoomMemoryBriefing('room:rbclaw', [
      {
        id: 1,
        scopeKind: 'room',
        scopeKey: 'room:rbclaw',
        content: '사용자는 세션 리셋 후에도 방 맥락이 이어지길 원함.',
        keywords: ['room:rbclaw'],
        memoryKind: 'decision',
        sourceKind: 'explicit',
        sourceRef: 'msg:1',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        archivedAt: null,
      },
      {
        id: 2,
        scopeKind: 'room',
        scopeKey: 'room:rbclaw',
        content:
          '자동 recall/compact persist를 호스트가 책임지는 방향으로 합의함.',
        keywords: ['room:rbclaw'],
        memoryKind: null,
        sourceKind: 'compact',
        sourceRef: 'compact:1',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        archivedAt: null,
      },
    ]);

    expect(briefing).toContain('## Shared Room Memory');
    expect(briefing).toContain('room:rbclaw');
    expect(briefing).toContain(
      '[decision] 사용자는 세션 리셋 후에도 방 맥락이 이어지길 원함.',
    );
    expect(briefing).toContain(
      '- 자동 recall/compact persist를 호스트가 책임지는 방향으로 합의함.',
    );
  });

  it('builds a room briefing from stored SQLite memories', async () => {
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:rbclaw',
      content: '방 메모리는 새 세션 시작 시에만 주입한다.',
      keywords: ['room:rbclaw', 'session-start'],
      sourceKind: 'compact',
      sourceRef: 'compact:test',
    });

    const briefing = await buildRoomMemoryBriefing({
      groupFolder: 'rbclaw',
      groupName: 'RBClaw',
    });

    expect(briefing).toContain('## Shared Room Memory');
    expect(briefing).toContain('방 메모리는 새 세션 시작 시에만 주입한다.');
  });

  it('trims overly long briefings to the configured max length', () => {
    const briefing = formatRoomMemoryBriefing(
      'room:rbclaw',
      [
        {
          id: 1,
          scopeKind: 'room',
          scopeKey: 'room:rbclaw',
          content: 'a'.repeat(300),
          keywords: [],
          memoryKind: null,
          sourceKind: 'compact',
          sourceRef: 'compact:1',
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          archivedAt: null,
        },
      ],
      120,
    );

    expect(briefing).toBeDefined();
    expect(briefing!.length).toBeLessThanOrEqual(120);
    expect(briefing!.endsWith('…')).toBe(true);
  });
});
