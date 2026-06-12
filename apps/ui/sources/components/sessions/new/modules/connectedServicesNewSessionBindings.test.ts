import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '@happier-dev/agents';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    buildConnectedServicesBindingsPayload,
    type ConnectedServicesProfileOptionsByServiceId,
} from './connectedServicesNewSessionBindings';

const profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId = {
    'openai-codex': [
        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
    ],
};

describe('buildConnectedServicesBindingsPayload', () => {
    it('emits a group binding without using the stored fallback profile id', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'backup',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                },
            },
        });
    });

    it('preserves a viable group binding when the active member needs reauth but another member is connected', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: {
                'openai-codex': [
                    { profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
            accountGroupsFeatureEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                },
            },
        });
    });

    it('degrades a missing group binding to native instead of a stale profile preference', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: true,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-group',
                    profileId: 'missing',
                },
            },
            defaultProfileByServiceId: { 'openai-codex': 'backup' },
        });

        expect(payload).toBeNull();
    });

    it('degrades a group binding to native when account groups are disabled for the target server', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: false,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toBeNull();
    });

    it('degrades a group binding to native when the target runtime cannot switch account groups', () => {
        const payload = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['openai-codex'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            accountGroupsFeatureEnabled: true,
            accountGroupSwitchingEnabled: false,
            connectedServiceAccountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'codex-main',
                    label: 'Codex main',
                    activeProfileId: 'work',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            connectedServicesBindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(payload).toBeNull();
    });
});

describe('buildConnectedServiceProfileOptionsByServiceId', () => {
    it('keeps OpenCode Claude subscription OAuth profiles visible as setup-token action rows', () => {
        const options = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: [{
                serviceId: 'claude-subscription',
                profiles: [
                    {
                        profileId: 'claude-pro-token',
                        status: 'connected',
                        kind: 'token',
                        providerEmail: 'token@example.com',
                    },
                    {
                        profileId: 'claude-pro-oauth',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'oauth@example.com',
                    },
                ],
            }],
            agentCore: AGENTS_CORE.opencode,
            supportedConnectedServiceIds: AGENTS_CORE.opencode.connectedServices?.supportedServiceIds ?? [],
            labelsByKey: {},
        });

        expect(options['claude-subscription']).toEqual([
            expect.objectContaining({
                profileId: 'claude-pro-token',
                status: 'connected',
                kind: 'token',
            }),
            expect.objectContaining({
                profileId: 'claude-pro-oauth',
                status: 'unsupported_kind',
                kind: 'oauth',
                unsupportedSubtitleKey: 'connectedServices.detail.connectSetupTokenSubtitle',
            }),
        ]);
    });
});

describe('buildConnectedServiceAccountGroupOptionsByServiceId', () => {
    it('does not expose account-group options when account groups are disabled', () => {
        const options = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: false,
            accountProfileConnectedServicesV2: [{
                serviceId: 'openai-codex',
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'work',
                    members: [{ profileId: 'work', enabled: true }],
                }],
            }],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(options).toEqual({});
    });

    it('counts profile ids projected by the account profile API as enabled group members', () => {
        const options = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            accountProfileConnectedServicesV2: [{
                serviceId: 'openai-codex',
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                }],
            }],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(options['openai-codex']).toEqual([expect.objectContaining({
            groupId: 'codex-main',
            enabledMemberCount: 2,
            status: 'ready',
        })]);
    });

    it('prefers state.status when projecting exhausted account groups', () => {
        const options = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            accountProfileConnectedServicesV2: [{
                serviceId: 'openai-codex',
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'work',
                    memberProfileIds: ['work', 'backup'],
                    state: {
                        status: 'exhausted',
                    },
                }],
            }],
            supportedConnectedServiceIds: ['openai-codex'],
        });

        expect(options['openai-codex']).toEqual([expect.objectContaining({
            groupId: 'codex-main',
            enabledMemberCount: 2,
            status: 'exhausted',
        })]);
    });
});
