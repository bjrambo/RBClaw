import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  createPairedTask,
  getChannelOwnerLease,
  getLatestTurnNumber,
  getPairedTaskById,
  getPairedTurnOutputs,
  getStoredRoomSettings,
  insertPairedTurnOutput,
  setChannelOwnerLease,
  updatePairedTask,
} from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  OWNER_AGENT_TYPE,
} from './config.js';
import { migrateLegacyRoomRegistrationsInFile } from '../test/helpers/db-test-utils.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('paired task state', () => {
  it('stores the channel work directory on the task', () => {
    createPairedTask({
      id: 'paired-task-1',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      work_dir: '/tmp/paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: 'wire up workspaces',
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    expect(getPairedTaskById('paired-task-1')).toMatchObject({
      status: 'active',
      work_dir: '/tmp/paired-room',
    });
  });

  it('updates task state without changing its work directory', () => {
    createPairedTask({
      id: 'paired-task-2',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    updatePairedTask('paired-task-2', {
      status: 'review_ready',
      review_requested_at: '2026-03-28T00:10:00.000Z',
      updated_at: '2026-03-28T00:10:00.000Z',
    });

    expect(getPairedTaskById('paired-task-2')).toMatchObject({
      status: 'review_ready',
      work_dir: '/tmp/rbclaw-test-work',
    });
  });

  it('stores paired turn outputs in order and truncates oversized text', () => {
    createPairedTask({
      id: 'paired-task-turn-output',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    insertPairedTurnOutput(
      'paired-task-turn-output',
      2,
      'reviewer',
      'review turn',
    );
    insertPairedTurnOutput(
      'paired-task-turn-output',
      1,
      'owner',
      'x'.repeat(60_000),
    );

    const outputs = getPairedTurnOutputs('paired-task-turn-output');

    expect(outputs.map((output) => output.turn_number)).toEqual([1, 2]);
    expect(outputs[0].role).toBe('owner');
    expect(outputs[0].output_text).toHaveLength(50_000);
    expect(outputs[0].verdict).toBe('continue');
    expect(outputs[1].output_text).toBe('review turn');
    expect(outputs[1].verdict).toBe('continue');
    expect(getLatestTurnNumber('paired-task-turn-output')).toBe(2);
  });

  it('stores the parsed visible verdict with paired turn outputs', () => {
    createPairedTask({
      id: 'paired-task-turn-output-verdict',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    insertPairedTurnOutput(
      'paired-task-turn-output-verdict',
      1,
      'owner',
      'STEP_DONE\n1단계 완료',
    );
    insertPairedTurnOutput(
      'paired-task-turn-output-verdict',
      2,
      'owner',
      'TASK_DONE\n요청 범위 전체 완료',
    );

    const outputs = getPairedTurnOutputs('paired-task-turn-output-verdict');

    expect(outputs.map((output) => output.verdict)).toEqual([
      'step_done',
      'task_done',
    ]);
  });

  it('preserves explicit created_at when inserting a paired turn output', () => {
    createPairedTask({
      id: 'paired-task-turn-output-created-at',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    insertPairedTurnOutput(
      'paired-task-turn-output-created-at',
      0,
      'owner',
      'carried forward owner final',
      '2026-03-28T00:01:23.000Z',
    );

    const outputs = getPairedTurnOutputs('paired-task-turn-output-created-at');

    expect(outputs).toHaveLength(1);
    expect(outputs[0].created_at).toBe('2026-03-28T00:01:23.000Z');
  });
});

describe('paired task service id integrity', () => {
  it('fails init when paired task agent and service metadata conflict', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-paired-task-shadow-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-legacy-1',
        'dc:paired',
        'paired-room',
        CODEX_REVIEW_SERVICE_ID,
        CODEX_MAIN_SERVICE_ID,
        'codex',
        'claude-code',
        'codex',
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /paired_tasks\(paired-legacy-1\): reviewer_agent_type conflicts with reviewer_service_id/,
    );
  });

  it('preserves raw legacy paired task service ids during init when failover created the task', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-paired-task-legacy-failover-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE paired_projects (
        chat_jid TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        canonical_work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO paired_projects VALUES (
        'dc:paired-failover',
        'paired-failover-room',
        '/tmp/paired-failover-room',
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z'
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-legacy-failover',
        'dc:paired-failover',
        'paired-failover-room',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        null,
        null,
        'legacy failover task',
        null,
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getPairedTaskById('paired-legacy-failover')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
    });
  });

  it('backfills configured owner agent type when creating a paired task with a raw non-shadow owner service id', () => {
    createPairedTask({
      id: 'paired-task-raw-owner-service',
      chat_jid: 'dc:paired-raw-owner-service',
      group_folder: 'paired-raw-owner-service',
      work_dir: '/tmp/rbclaw-test-work',
      owner_service_id: 'andy',
      reviewer_service_id: CLAUDE_SERVICE_ID,
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    expect(getPairedTaskById('paired-task-raw-owner-service')).toMatchObject({
      owner_service_id: 'andy',
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: OWNER_AGENT_TYPE,
      reviewer_agent_type: 'claude-code',
    });
  });
});

describe('paired task legacy service ids', () => {
  it('preserves raw legacy paired task service ids during init when registered group metadata is present', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-paired-task-legacy-groups-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb.exec(`
      CREATE TABLE paired_projects (
        chat_jid TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        canonical_work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO paired_projects VALUES (
        'dc:paired-failover-groups',
        'paired-failover-groups',
        '/tmp/paired-failover-groups',
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z'
      );
    `);

    const insertGroup = legacyDb.prepare(
      `INSERT INTO registered_groups (
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        agent_config,
        requires_trigger,
        is_main,
        agent_type,
        work_dir
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, ?)`,
    );
    insertGroup.run(
      'dc:paired-failover-groups',
      'Legacy Failover Groups',
      'paired-failover-groups',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
      '/tmp/paired-failover-groups',
    );
    insertGroup.run(
      'dc:paired-failover-groups',
      'Legacy Failover Groups',
      'paired-failover-groups',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
      '/tmp/paired-failover-groups',
    );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-legacy-groups',
        'dc:paired-failover-groups',
        'paired-failover-groups',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        null,
        null,
        'legacy failover with groups',
        null,
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 1,
      migratedRoleOverrides: 2,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getPairedTaskById('paired-legacy-groups')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
    });
  });

  it('preserves raw legacy channel owner lease service ids during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-channel-owner-legacy-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE channel_owner (
        chat_jid TEXT PRIMARY KEY,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT,
        arbiter_service_id TEXT,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        activated_at TEXT,
        reason TEXT
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO channel_owner (
          chat_jid,
          owner_service_id,
          reviewer_service_id,
          arbiter_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          activated_at,
          reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:legacy-channel-owner',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        'legacy-failover',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getChannelOwnerLease('dc:legacy-channel-owner')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
    });
  });
});

describe('paired task canonical metadata reads', () => {
  it('fails fast when a paired task row loses canonical agent metadata after init', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-paired-task-strict-read-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      const fileDb = new Database(dbPath);
      initializeDatabaseSchema(fileDb);
      fileDb.close();

      _initTestDatabaseFromFile(dbPath);
      createPairedTask({
        id: 'paired-task-strict-read',
        chat_jid: 'dc:paired-task-strict-read',
        group_folder: 'paired-task-strict-read',
        work_dir: '/tmp/rbclaw-test-work',
        owner_service_id: CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: CLAUDE_SERVICE_ID,
        owner_agent_type: 'codex',
        reviewer_agent_type: 'claude-code',
        arbiter_agent_type: null,
        title: 'strict read task',
        source_ref: null,
        plan_notes: null,
        review_requested_at: null,
        round_trip_count: 0,
        status: 'active',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      });

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `UPDATE paired_tasks
              SET reviewer_agent_type = NULL
            WHERE id = ?`,
        )
        .run('paired-task-strict-read');
      rawDb.close();

      expect(() => getPairedTaskById('paired-task-strict-read')).toThrow(
        /cannot read reviewer_agent_type from stored row metadata/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('preserves stored reviewer service ids during init even when reviewer agent metadata exists', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/rbclaw-channel-owner-stored-reviewer-',
    );
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE channel_owner (
        chat_jid TEXT PRIMARY KEY,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT,
        arbiter_service_id TEXT,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        activated_at TEXT,
        reason TEXT
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO channel_owner (
          chat_jid,
          owner_service_id,
          reviewer_service_id,
          arbiter_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          activated_at,
          reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:legacy-channel-owner-stored-reviewer',
        CLAUDE_SERVICE_ID,
        'stale-reviewer-shadow',
        null,
        'claude-code',
        'codex',
        null,
        '2026-03-28T00:00:00.000Z',
        'legacy-reviewer-stored-id',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getChannelOwnerLease('dc:legacy-channel-owner-stored-reviewer'),
    ).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: 'stale-reviewer-shadow',
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
    });
  });

  it('fails fast when a channel owner lease row loses canonical reviewer metadata after init', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-channel-owner-strict-read-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      const fileDb = new Database(dbPath);
      initializeDatabaseSchema(fileDb);
      fileDb.close();

      _initTestDatabaseFromFile(dbPath);
      setChannelOwnerLease({
        chat_jid: 'dc:channel-owner-strict-read',
        owner_service_id: CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: CLAUDE_SERVICE_ID,
        owner_agent_type: 'codex',
        reviewer_agent_type: 'claude-code',
        reason: 'strict read setup',
      });

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `UPDATE channel_owner
              SET reviewer_agent_type = NULL
            WHERE chat_jid = ?`,
        )
        .run('dc:channel-owner-strict-read');
      rawDb.close();

      expect(() =>
        getChannelOwnerLease('dc:channel-owner-strict-read'),
      ).toThrow(/cannot read reviewer_agent_type from stored row metadata/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('paired task room settings conflicts', () => {
  it('fails init when stored paired task metadata conflicts with stored service ids even if room settings differ', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-paired-task-ssot-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO room_settings (
          chat_jid,
          room_mode,
          mode_source,
          owner_agent_type,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:task-ssot',
        'tribunal',
        'explicit',
        'codex',
        '2026-03-28T00:00:00.000Z',
      );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-task-ssot',
        'dc:task-ssot',
        'task-ssot-room',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        'claude-code',
        'codex',
        'codex',
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /paired_tasks\(paired-task-ssot\): owner_agent_type conflicts with owner_service_id/,
    );
  });
});

describe('paired task explicit room trigger preservation', () => {
  it('preserves explicit room trigger during init without rewriting task agent metadata from room settings', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-room-settings-ssot-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO room_settings (
          chat_jid,
          room_mode,
          mode_source,
          name,
          folder,
          trigger_pattern,
          requires_trigger,
          is_main,
          owner_agent_type,
          work_dir,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:explicit-owner',
        'tribunal',
        'explicit',
        'Explicit Owner Room',
        'explicit-owner-room',
        '@Custom',
        1,
        0,
        'claude-code',
        '/tmp/explicit-owner',
        '2026-03-28T00:00:00.000Z',
      );

    const insertGroup = legacyDb.prepare(
      `INSERT INTO registered_groups (
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        agent_config,
        requires_trigger,
        is_main,
        agent_type,
        work_dir
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL)`,
    );
    insertGroup.run(
      'dc:explicit-owner',
      'Explicit Owner Room',
      'explicit-owner-room',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:explicit-owner',
      'Explicit Owner Room',
      'explicit-owner-room',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-explicit-owner',
        'dc:explicit-owner',
        'explicit-owner-room',
        CODEX_REVIEW_SERVICE_ID,
        CODEX_MAIN_SERVICE_ID,
        null,
        null,
        null,
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 0,
      migratedRoleOverrides: 2,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:explicit-owner')).toMatchObject({
      roomMode: 'tribunal',
      modeSource: 'explicit',
      ownerAgentType: 'claude-code',
      trigger: '@Custom',
    });
    expect(getPairedTaskById('paired-explicit-owner')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CODEX_MAIN_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: ARBITER_AGENT_TYPE ?? null,
    });
  });
});

describe('paired task explicit room trigger without owner agent type', () => {
  it('preserves explicit room trigger during init even when legacy explicit rows lack owner agent type', () => {
    const tempDir = fs.mkdtempSync('/tmp/rbclaw-room-settings-trigger-ssot-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO room_settings (
          chat_jid,
          room_mode,
          mode_source,
          name,
          folder,
          trigger_pattern,
          requires_trigger,
          is_main,
          owner_agent_type,
          work_dir,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:explicit-trigger-only',
        'tribunal',
        'explicit',
        'Explicit Trigger Room',
        'explicit-trigger-room',
        '@Custom',
        1,
        0,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
      );

    const insertGroup = legacyDb.prepare(
      `INSERT INTO registered_groups (
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        agent_config,
        requires_trigger,
        is_main,
        agent_type,
        work_dir
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL)`,
    );
    insertGroup.run(
      'dc:explicit-trigger-only',
      'Explicit Trigger Room',
      'explicit-trigger-room',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:explicit-trigger-only',
      'Explicit Trigger Room',
      'explicit-trigger-room',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );
    legacyDb.close();

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 0,
      migratedRoleOverrides: 2,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:explicit-trigger-only')).toMatchObject({
      roomMode: 'tribunal',
      modeSource: 'explicit',
      trigger: '@Custom',
    });
  });
});
