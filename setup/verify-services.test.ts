import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock, isRootMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  isRootMock: vi.fn(() => false),
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('./platform.js', () => ({
  isRoot: isRootMock,
}));

import {
  checkLaunchdService,
  checkLaunchdServiceArtifact,
  checkNohupService,
  checkNohupServiceArtifact,
  checkSystemdService,
  checkSystemdServiceInScope,
  getServiceChecks,
} from './verify-services.js';
import type { ServiceDef } from './service-defs.js';

describe('verify service checks', () => {
  afterEach(() => {
    execSyncMock.mockReset();
    isRootMock.mockReset();
    isRootMock.mockReturnValue(false);
    vi.restoreAllMocks();
  });

  it('treats launchd entries with a PID as running', () => {
    execSyncMock.mockReturnValue('123\t0\tcom.rbclaw\n');

    expect(checkLaunchdService('com.rbclaw')).toBe('running');
  });

  it('treats launchd entries without a PID as stopped', () => {
    execSyncMock.mockReturnValue('-\t0\tcom.rbclaw\n');

    expect(checkLaunchdService('com.rbclaw')).toBe('stopped');
  });

  it('checks systemd user services with the user prefix', () => {
    isRootMock.mockReturnValue(false);
    execSyncMock.mockReturnValue(undefined);

    expect(checkSystemdService('rbclaw')).toBe('running');
    expect(execSyncMock).toHaveBeenCalledWith(
      'systemctl --user is-active rbclaw',
      {
        stdio: 'ignore',
      },
    );
  });

  it('checks systemd services in both explicit scopes', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'systemctl is-active rbclaw-codex') {
        return undefined;
      }
      if (cmd === 'systemctl --user is-active rbclaw-codex') {
        throw new Error('inactive');
      }
      if (cmd === 'systemctl --user list-unit-files') {
        return '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    expect(checkSystemdServiceInScope('rbclaw-codex', 'system')).toBe(
      'running',
    );
    expect(checkSystemdServiceInScope('rbclaw-codex', 'user')).toBe(
      'not_found',
    );
  });

  it('treats an unloaded launchd plist as stopped when artifact detection is enabled', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-launchd-'));
    const plistPath = path.join(
      tempHome,
      'Library',
      'LaunchAgents',
      'com.rbclaw-codex.plist',
    );
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, '<plist />');
    execSyncMock.mockReturnValue('');

    expect(checkLaunchdServiceArtifact('com.rbclaw-codex', plistPath)).toBe(
      'stopped',
    );

    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('treats known but inactive systemd services as stopped', () => {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('inactive');
      })
      .mockReturnValueOnce('rbclaw.service enabled\n');

    expect(checkSystemdService('rbclaw')).toBe('stopped');
  });

  it('treats a live nohup PID as running', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-verify-'));
    const pidFile = path.join(tempRoot, 'rbclaw.pid');
    fs.writeFileSync(pidFile, '12345\n');

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    expect(checkNohupService(tempRoot, 'rbclaw')).toBe('running');

    killSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('treats a legacy nohup wrapper without a live pid as stopped when artifact detection is enabled', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-verify-'));
    fs.writeFileSync(
      path.join(tempRoot, 'start-rbclaw-codex.sh'),
      '#!/bin/bash\n',
    );

    expect(checkNohupServiceArtifact(tempRoot, 'rbclaw-codex')).toBe('stopped');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('builds per-service status checks from service definitions', () => {
    const defs: ServiceDef[] = [
      {
        kind: 'primary',
        name: 'rbclaw',
        description: 'RBClaw',
        launchdLabel: 'com.rbclaw',
        logName: 'rbclaw',
      },
      {
        kind: 'primary',
        name: 'rbclaw-secondary',
        description: 'Secondary',
        launchdLabel: 'com.rbclaw.secondary',
        logName: 'rbclaw-secondary',
      },
    ];
    execSyncMock.mockReturnValue('123\t0\tcom.rbclaw\n');

    expect(getServiceChecks(defs, '/tmp/rbclaw', 'launchd')).toEqual([
      { name: 'rbclaw', status: 'running' },
      { name: 'rbclaw-secondary', status: 'not_found' },
    ]);
  });
});
