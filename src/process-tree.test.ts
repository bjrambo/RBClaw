import type { ChildProcess } from 'child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { signalProcessTree } from './process-tree.js';

describe('signalProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signals the detached process group on Unix', () => {
    const kill = vi.fn(() => true);
    const proc = { pid: 4242, kill } as unknown as ChildProcess;
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(signalProcessTree(proc, 'SIGTERM')).toBe(true);
    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to the direct child when the process group is gone', () => {
    const kill = vi.fn(() => true);
    const proc = { pid: 4242, kill } as unknown as ChildProcess;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('missing process group') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    expect(signalProcessTree(proc, 'SIGKILL')).toBe(true);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
