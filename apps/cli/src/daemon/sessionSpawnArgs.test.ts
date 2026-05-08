import { describe, expect, it } from 'vitest';

import { buildHappySessionControlArgs } from './sessionSpawnArgs';

describe('buildHappySessionControlArgs', () => {
  it('includes permission mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
    })).toEqual(['--permission-mode', 'safe-yolo', '--permission-mode-updated-at', '123']);
  });

  it('includes model flags when provided', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: 456,
    })).toEqual(['--model', 'o3', '--model-updated-at', '456']);
  });

  it('includes agent mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      agentModeId: 'plan',
    })).toEqual(['--agent-mode', 'plan']);
  });

  it('omits model flags when modelUpdatedAt is missing', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: undefined,
    })).toEqual([]);
  });

  it('omits model flags when modelId is empty', () => {
    expect(buildHappySessionControlArgs({
      modelId: '   ',
      modelUpdatedAt: 456,
    })).toEqual([]);
  });

  it('includes resume and existing-session flags when values are present', () => {
    expect(buildHappySessionControlArgs({
      resume: '  resume-id  ',
      existingSessionId: ' existing-session-id ',
    })).toEqual(['--resume', 'resume-id', '--existing-session', 'existing-session-id']);
  });

  it('includes permission mode without timestamp when updatedAt is absent', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe',
    })).toEqual(['--permission-mode', 'safe']);
  });

  it('normalizes yolo to a Claude-compatible permission token for built-in Claude sessions', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
    })).toEqual(['--permission-mode', 'bypassPermissions', '--permission-mode-updated-at', '123']);
  });

  it('normalizes safe-yolo to a Claude-compatible permission token for built-in Claude sessions', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'safe-yolo',
    })).toEqual(['--permission-mode', 'acceptEdits']);
  });

  it('supports model timestamp boundary value zero', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: 0,
    })).toEqual(['--model', 'o3', '--model-updated-at', '0']);
  });

  it('includes account settings version hints when provided', () => {
    expect(buildHappySessionControlArgs({
      accountSettingsVersionHint: 14,
    })).toEqual(['--account-settings-version-hint', '14']);
  });

  it('includes backend flag when the backend target is a configured ACP backend', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: { kind: 'configuredAcpBackend', backendId: ' custom-kiro ' },
    })).toEqual(['--backend', 'custom-kiro']);
  });

  it('includes account settings version hint when provided', () => {
    expect(buildHappySessionControlArgs({
      accountSettingsVersionHint: 123,
    })).toEqual(['--account-settings-version-hint', '123']);
  });
});
