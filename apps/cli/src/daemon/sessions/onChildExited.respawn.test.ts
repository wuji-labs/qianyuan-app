import { describe, expect, it, vi } from 'vitest';

import { createOnChildExited } from './onChildExited';

describe('createOnChildExited', () => {
  it('queues durable session-end when a tracked child exits', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'session-1',
      exit: expect.objectContaining({
        observedBy: 'daemon',
        pid,
        reason: 'process-exited',
      }),
    }));
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
  });

  it('invokes onUnexpectedExit hook for non-zero exits with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ happySessionId: 'session-1', pid: 123 }),
      expect.objectContaining({ code: 1 }),
    );
  });

  it('invokes onUnexpectedExit hook for process-missing with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-missing', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onUnexpectedExit hook for SIGTERM', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(0);
  });

  it('invokes onUnexpectedExit hook for SIGTERM when override marks it unexpected', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('promotes tracking to the runner pid and preserves the runner marker when the wrapper exits', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-1',
      }),
    );
    expect(pidToTrackedSession.get(runnerPid)?.sessionRunnerPid).toBeUndefined();
    killSpy.mockRestore();
  });

  it('promotes a live runner even when a connected-service restart marked the wrapper exit as unexpected', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const onUnexpectedExit = vi.fn();
    const onPidPromoted = vi.fn();
    const removeSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
      onPidPromoted,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
      pid: runnerPid,
    }));
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    expect(onPidPromoted).toHaveBeenCalledWith(expect.objectContaining({
      fromPid: wrapperPid,
      toPid: runnerPid,
      trackedSession: expect.objectContaining({ happySessionId: 'session-1' }),
    }));
    killSpy.mockRestore();
  });

  it('transfers pid-owned cleanup registrations when promoting wrapper tracking to the runner', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const wrapperCleanup = vi.fn();
    const wrapperAttachCleanup = vi.fn(async () => {});
    const spawnResourceCleanupByPid = new Map<number, () => void>([[wrapperPid, wrapperCleanup]]);
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>([[wrapperPid, wrapperAttachCleanup]]);

    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(wrapperCleanup).not.toHaveBeenCalled();
    expect(wrapperAttachCleanup).not.toHaveBeenCalled();
    expect(spawnResourceCleanupByPid.has(wrapperPid)).toBe(false);
    expect(sessionAttachCleanupByPid.has(wrapperPid)).toBe(false);
    expect(spawnResourceCleanupByPid.get(runnerPid)).toBe(wrapperCleanup);
    expect(sessionAttachCleanupByPid.get(runnerPid)).toBe(wrapperAttachCleanup);
    killSpy.mockRestore();
  });

  it('removes both wrapper and runner markers when the wrapper exits after the runner is already gone', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(runnerPid);
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    killSpy.mockRestore();
  });
});
