import type { AgentState, Metadata, PermissionMode, UserMessage } from '@/api/types';

import { pushMessageToQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permission/appendSystemPromptField';
import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './permissionModeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './permissionModeFromUserMessage';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';

/**
 * Config change carried by a steered message that the backend must own BEFORE the text joins the
 * active turn (lane Q). Today this is the permission mode only; new members must stay optional so
 * existing capability implementations keep compiling.
 */
export type SteerConfigDelta = Readonly<{
  permissionMode: PermissionMode;
}>;

/**
 * Outcome of an in-flight config-delta application (lane Q):
 * - `applied`: the backend verified the config is effective for the running turn.
 * - `scheduled_in_turn`: the backend owns the delta and will apply it at the next safe point
 *   DURING the current turn (still before/independent of the steered text's effect window).
 * - `unsupported` / `failed`: the backend cannot own the delta mid-turn — the message must take
 *   the legacy queue path (config applies when the queue drains at turn end).
 */
export type InFlightConfigApplyOutcome = Readonly<
  | { status: 'applied' }
  | { status: 'scheduled_in_turn' }
  | { status: 'unsupported'; reason?: string | undefined }
  | { status: 'failed'; reason?: string | undefined }
>;

export type InFlightSteerController = Readonly<{
  /**
   * Whether the runtime is currently processing a turn (i.e. can accept steer input).
   */
  isTurnInFlight: () => boolean;
  /**
   * Whether the runtime/backend combination supports steering input into an active turn.
   */
  supportsInFlightSteer: () => boolean;
  /**
   * Send additional user text to the in-flight turn.
   *
   * This should NOT abort the current turn.
   */
  steerText: (text: string) => Promise<void>;
  /**
   * OPTIONAL capability (lane Q): apply a config delta to the RUNNING turn so a config-carrying
   * message can still steer. Backends that cannot own mid-turn config changes (e.g. Codex —
   * turn-boundary protocol) simply do not implement this; their messages keep the queue path.
   */
  applyConfigDeltaInFlight?: ((delta: SteerConfigDelta) => Promise<InFlightConfigApplyOutcome>) | undefined;
}>;

export function registerPermissionModeMessageQueueBinding(opts: {
  session: PermissionModeQueueSessionBinding;
  queue: SpecialCommandQueue<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  inFlightSteer?: InFlightSteerController | null;
}): { bindSession: (session: PermissionModeQueueSessionBinding) => void } {
  let steerSequence: Promise<void> = Promise.resolve();
  let didReplaySeedBootstrapForSteer = false;
  let currentSession = opts.session;

  const handleMessage = (session: PermissionModeQueueSessionBinding, message: UserMessage) => {
    if (currentSession !== session) {
      return;
    }

    const previousPermissionMode = opts.getCurrentPermissionMode();
    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: previousPermissionMode,
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) =>
        updateMetadataBestEffort(session, updater, '[permissionMode]', 'permission_mode_from_user_message'),
      nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
    });

    opts.setCurrentPermissionMode(resolvedMode.currentPermissionMode);

    const text = message.content.text;
    const special = parseSpecialCommand(text);
    const didChangePermissionMode = previousPermissionMode !== resolvedMode.currentPermissionMode;

    // In-flight steer is only valid when:
    // - the runtime is currently processing a turn,
    // - steering is supported,
    // - the message is not a control command like /clear or /compact,
    // - and the message either does NOT alter permission mode, or the backend exposes the
    //   `applyConfigDeltaInFlight` capability (lane Q) so it can own the mode change mid-turn.
    //   Without the capability, mode changes keep the queue path (handled by the main loop).
    const steer = opts.inFlightSteer;
    const pushToQueueBestEffort = () => {
      try {
        pushMessageToQueueWithSpecialCommands({
          queue: opts.queue,
          message: { text, localId: message.localId ?? null, ...(message.meta ? { meta: message.meta } : {}) },
          text,
          mode: {
            permissionMode: resolvedMode.queuePermissionMode,
            ...resolveAppendSystemPromptModeOverride(message.meta),
          },
        });
      } catch {
        // Best-effort fallback: queueing should not be able to crash the process if a steer fails.
      }
    };
    if (
      steer &&
      steer.supportsInFlightSteer() &&
      steer.isTurnInFlight() &&
      special.type === null &&
      (!didChangePermissionMode || typeof steer.applyConfigDeltaInFlight === 'function')
    ) {
      const applyConfigDelta = didChangePermissionMode ? steer.applyConfigDeltaInFlight : undefined;
      steerSequence = steerSequence.then(async () => {
        if (applyConfigDelta) {
          let configOutcome: InFlightConfigApplyOutcome;
          try {
            configOutcome = await applyConfigDelta({ permissionMode: resolvedMode.queuePermissionMode });
          } catch {
            configOutcome = { status: 'failed', reason: 'config_apply_threw' };
          }
          if (configOutcome.status !== 'applied' && configOutcome.status !== 'scheduled_in_turn') {
            // The backend cannot own the config mid-turn: legacy queue path (the mode applies when
            // the queue drains). Not a bounce — the steer was never accepted — so no corrective
            // unsafe_window publish (the UI already routes known-refused payloads honestly).
            pushToQueueBestEffort();
            return;
          }
        }
        try {
          let providerText = text;
          if (typeof session.getMetadataSnapshot === 'function') {
            try {
              const seedResolution = await resolveProviderPromptWithReplaySeed({
                session: {
                  getMetadataSnapshot: session.getMetadataSnapshot,
                  updateMetadata: session.updateMetadata,
                  refreshSessionSnapshotFromServerBestEffort: session.refreshSessionSnapshotFromServerBestEffort,
                },
                userText: text,
                allowSeed: true,
                localId: message.localId ?? null,
                nowMs: Date.now(),
                refreshMetadataBeforeRead: !didReplaySeedBootstrapForSteer,
              });
              didReplaySeedBootstrapForSteer = true;
              providerText = seedResolution.providerPrompt;
            } catch {
              // Best-effort only; fall back to steering the raw user text.
            }
          }

          await steer.steerText(providerText);
          return;
        } catch {
          pushToQueueBestEffort();
          // Lane P (O-design Seam A corrective): a steer the runner accepted just BOUNCED to the
          // queue — tell the UI the window is unsafe so the demotion is not silent.
          publishSteerBounceUnavailable(session);
        }
      });
      return;
    }

    pushMessageToQueueWithSpecialCommands({
      queue: opts.queue,
      message: { text, localId: message.localId ?? null, ...(message.meta ? { meta: message.meta } : {}) },
      text,
      mode: {
        permissionMode: resolvedMode.queuePermissionMode,
        ...resolveAppendSystemPromptModeOverride(message.meta),
      },
    });
  };

  const bindSession = (session: PermissionModeQueueSessionBinding) => {
    currentSession = session;
    session.onUserMessage((message) => {
      handleMessage(session, message);
    });
  };

  bindSession(opts.session);

  return { bindSession };
}

function publishSteerBounceUnavailable(session: PermissionModeQueueSessionBinding): void {
  const updateAgentState = session.updateAgentState;
  if (typeof updateAgentState !== 'function') return;
  updateAgentStateBestEffort(
    { updateAgentState: updateAgentState.bind(session) },
    (current) => ({
      ...current,
      capabilities: {
        ...(current.capabilities && typeof current.capabilities === 'object' ? current.capabilities : {}),
        inFlightSteerAvailable: false,
        inFlightSteerUnavailableReason: 'unsafe_window',
        inFlightSteerStateAt: Date.now(),
      },
    }),
    '[permissionMode]',
    'in_flight_steer_bounce',
  );
}

type PermissionModeQueueSessionBinding = {
  onUserMessage: (handler: (message: UserMessage) => void) => void;
  updateMetadata: (updater: (current: Metadata) => Metadata) => Promise<void> | void;
  updateAgentState?: (updater: (current: AgentState) => AgentState) => Promise<void> | void;
  getMetadataSnapshot?: () => unknown;
  refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
};
