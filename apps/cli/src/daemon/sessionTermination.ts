import type { TrackedSession } from './types';

type DaemonObservedExit = {
  reason: string;
  code?: number | null;
  signal?: string | null;
};

export type DaemonSessionEndPayload = Readonly<{
  sid: string;
  time: number;
  exit: Readonly<{
    observedBy: 'daemon';
    pid: number;
    reason: string;
    code: number | null;
    signal: string | null;
  }>;
}>;

export function reportDaemonObservedSessionExit(opts: {
  apiMachine: {
    emitSessionEnd: (payload: DaemonSessionEndPayload) => void;
    enqueueSessionEndMutation?: (payload: DaemonSessionEndPayload) => void;
  };
  trackedSession: TrackedSession;
  now: () => number;
  exit: DaemonObservedExit;
}) {
  const { apiMachine, trackedSession, now, exit } = opts;

  if (!trackedSession.happySessionId) {
    return;
  }

  const payload = {
    sid: trackedSession.happySessionId,
    time: now(),
    exit: {
      observedBy: 'daemon',
      pid: trackedSession.pid,
      reason: exit.reason,
      code: exit.code ?? null,
      signal: exit.signal ?? null,
    },
  } satisfies DaemonSessionEndPayload;

  if (apiMachine.enqueueSessionEndMutation) {
    apiMachine.enqueueSessionEndMutation(payload);
    return;
  }

  apiMachine.emitSessionEnd(payload);
}
