import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
    buildConnectedServiceGroupMemberActions,
    formatConnectedServiceGroupMemberSubtitle,
    formatConnectedServiceGroupSubtitle,
    parseConnectedServiceGroupViewModels,
    resolveConnectedServiceGroupMemberIdentity,
    resolveConnectedServiceGroupProfileTitle,
} from './connectedServiceGroupViewModel';

describe('connectedServiceGroupViewModel', () => {
    it('normalizes legacy group projections into a stable group view model', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            label: 'Primary pool',
            activeProfileId: 'work',
            strategy: 'manual',
            autoSwitch: true,
            generation: 4,
            state: { status: 'exhausted', cooldownUntilMs: 1_800_000_000_000 },
            members: [{
                profileId: 'work',
                priority: 10,
                enabled: false,
                state: {
                    exhaustedUntilMs: 1_800_000_010_000,
                    lastFailureKind: 'usage_limit',
                },
            }],
        }]);

        expect(group).toMatchObject({
            groupId: 'primary',
            label: 'Primary pool',
            activeProfileId: 'work',
            generation: 4,
            status: 'needs_members',
            cooldownUntilMs: 1_800_000_000_000,
            policy: {
                strategy: 'manual',
                autoSwitch: true,
            },
            members: [{
                profileId: 'work',
                enabled: false,
                priority: 10,
                exhaustedUntilMs: 1_800_000_010_000,
                lastFailureKind: 'usage_limit',
            }],
        });
    });

    it('formats member subtitle state from the normalized model', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'work',
            members: [{
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {
                    cooldownUntilMs: 1_800_000_000_000,
                    lastFailureKind: 'auth_expired',
                },
            }],
        }]);

        const subtitle = formatConnectedServiceGroupMemberSubtitle(group.members[0]!, group.activeProfileId);

        expect(subtitle).toContain(t('connectedServices.detail.groups.memberActive'));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberEnabled'));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberPriority', { priority: 10 }));
        expect(subtitle).toContain(t('connectedServices.detail.groups.memberLastFailure', { reason: 'auth_expired' }));
    });

    it('resolves a unified member identity with the display label primary and raw id only when distinct', () => {
        const labelled = resolveConnectedServiceGroupMemberIdentity({
            serviceId: 'openai-codex',
            profileId: 'work',
            labelsByKey: { 'openai-codex/work': 'Work account' },
        });
        expect(labelled).toMatchObject({ label: 'Work account', id: 'work', hasDistinctId: true });

        const unlabelled = resolveConnectedServiceGroupMemberIdentity({
            serviceId: 'openai-codex',
            profileId: 'work',
            labelsByKey: {},
        });
        expect(unlabelled).toMatchObject({ label: 'work', id: 'work', hasDistinctId: false });
    });

    it('shows the active member by display label in the group subtitle, not the raw profile id', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'batiplus',
            members: [{ profileId: 'batiplus', priority: 10, enabled: true }],
        }]);

        const subtitle = formatConnectedServiceGroupSubtitle(group, {
            serviceId: 'claude-subscription',
            labelsByKey: { 'claude-subscription/batiplus': 'leeroy' },
        });

        expect(subtitle).toContain('leeroy');
        expect(subtitle).not.toContain(t('connectedServices.detail.groups.activeMember', {
            member: 'batiplus',
        }));
        expect(subtitle).toContain(t('connectedServices.detail.groups.activeMember', {
            member: t('connectedServices.detail.groups.memberIdentity', { label: 'leeroy', id: 'batiplus' }),
        }));
    });

    it('falls back to the raw profile id in the group subtitle when no label is configured', () => {
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'batiplus',
            members: [{ profileId: 'batiplus', priority: 10, enabled: true }],
        }]);

        const subtitle = formatConnectedServiceGroupSubtitle(group);

        expect(subtitle).toContain(t('connectedServices.detail.groups.activeMember', { member: 'batiplus' }));
    });

    it('uses profile labels when resolving group member titles', () => {
        expect(resolveConnectedServiceGroupProfileTitle({
            serviceId: 'openai-codex',
            profileId: 'work',
            labelsByKey: { 'openai-codex/work': 'Work account' },
        })).toBe('Work account');
    });

    it('builds the shared member action model with fallback-disabled safeguards', () => {
        const onSetActiveMember = vi.fn();
        const onSetMemberEnabled = vi.fn();
        const onEditMemberPriority = vi.fn();
        const onRemoveMember = vi.fn();
        const [group] = parseConnectedServiceGroupViewModels([{
            groupId: 'primary',
            activeProfileId: 'work',
            members: [{ profileId: 'backup', priority: 20, enabled: true }],
        }]);

        const actions = buildConnectedServiceGroupMemberActions({
            groupId: group.groupId,
            activeProfileId: group.activeProfileId,
            member: group.members[0]!,
            accountFallbackEnabled: false,
            onSetActiveMember,
            onSetMemberEnabled,
            onEditMemberPriority,
            onRemoveMember,
        });

        expect(actions[0]).toMatchObject({
            id: 'connected-services-group:primary:member:backup:action:set-active',
            disabled: true,
        });

        actions[0]!.onPress?.();
        actions[1]!.onPress?.();
        actions[2]!.onPress?.();
        actions[3]!.onPress?.();

        expect(onSetActiveMember).toHaveBeenCalledWith('backup');
        expect(onSetMemberEnabled).toHaveBeenCalledWith(group.members[0], false);
        expect(onEditMemberPriority).toHaveBeenCalledWith(group.members[0]);
        expect(onRemoveMember).toHaveBeenCalledWith(group.members[0]);
    });
});
