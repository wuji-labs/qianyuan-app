import { describe, expect, it } from 'vitest';

import { shouldCommitAutomaticGroupApplySessionEvent } from './automaticGroupApplySessionEvents';

describe('shouldCommitAutomaticGroupApplySessionEvent', () => {
  it('keeps the final FSM switch row when runtime-auth recovery owns the user-visible event', () => {
    expect(shouldCommitAutomaticGroupApplySessionEvent({
      type: 'connected_service_account_switch',
      serviceId: 'openai-codex',
    }, { commitAccountSwitchEvents: true })).toBe(true);
  });

  it('suppresses the duplicate final FSM switch row when a coordinator-owned path already emits it', () => {
    expect(shouldCommitAutomaticGroupApplySessionEvent({
      type: 'connected_service_account_switch',
      serviceId: 'openai-codex',
    }, { commitAccountSwitchEvents: false })).toBe(false);
  });

  it('keeps switch attempts and deferral diagnostics owned by the FSM visible', () => {
    expect(shouldCommitAutomaticGroupApplySessionEvent({
      type: 'connected_service_account_switch_attempt',
      serviceId: 'openai-codex',
    }, { commitAccountSwitchEvents: false })).toBe(true);
    expect(shouldCommitAutomaticGroupApplySessionEvent({
      type: 'connected_service_account_switch_deferred',
      serviceId: 'openai-codex',
    }, { commitAccountSwitchEvents: false })).toBe(true);
  });

  it('keeps non-switch events untouched', () => {
    expect(shouldCommitAutomaticGroupApplySessionEvent(
      { type: 'message' },
      { commitAccountSwitchEvents: false },
    )).toBe(true);
    expect(shouldCommitAutomaticGroupApplySessionEvent(
      null,
      { commitAccountSwitchEvents: false },
    )).toBe(true);
  });
});
