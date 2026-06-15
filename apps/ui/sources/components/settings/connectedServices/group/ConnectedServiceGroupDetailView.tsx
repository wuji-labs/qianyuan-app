import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    addConnectedServiceAuthGroupMemberV3,
    listConnectedServiceAuthGroupsV3,
    patchConnectedServiceAuthGroupMemberV3,
    patchConnectedServiceAuthGroupV3,
    removeConnectedServiceAuthGroupMemberV3,
    setConnectedServiceAuthGroupActiveProfileV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { t } from '@/text';
import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceIdSchema,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
    isConnectedServiceRuntimeCooldownError,
    resolveConnectedServiceRuntimeCooldownOverridePrompt,
    resolveConnectedServiceSettingsErrorMessage,
} from '../errors/connectedServiceSettingsErrors';
import {
    buildConnectedServiceGroupMemberActions,
    CONNECTED_SERVICE_GROUP_DEFAULT_POLICY,
    formatConnectedServiceGroupMemberSubtitle,
    normalizeConnectedServiceGroupMember,
    readConnectedServiceGroupString,
    resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs,
    resolveConnectedServiceGroupMemberIdentity,
    resolveConnectedServiceGroupProfileTitle,
    resolveConnectedServiceGroupRecoveryMode,
    resolveConnectedServiceGroupSoftSwitchRemainingPercent,
    resolveConnectedServiceGroupSwitchBudget,
    type ConnectedServiceGroupMemberViewModel,
    type ConnectedServiceGroupProfileLike,
} from '../model/connectedServiceGroupViewModel';
import { resolveConnectedServiceRuntimeGroupCapability } from '../model/connectedServiceRuntimeFallbackCapability';
import { resolveConnectedServiceDisplayName } from '../model/resolveConnectedServiceDisplayName';

type GroupStrategy = ConnectedServiceAuthGroupV1['policy']['strategy'];
type GroupRecoveryMode = ConnectedServiceAuthGroupV1['policy']['recoveryMode'];

function resolveRecoveryModeSubtitle(mode: GroupRecoveryMode): string {
    if (mode === 'off') return t('connectedServices.detail.groupDetail.recoveryModeOffSubtitle');
    if (mode === 'wait_until_reset') return t('connectedServices.detail.groupDetail.recoveryModeWaitUntilResetSubtitle');
    if (mode === 'switch_then_resume') return t('connectedServices.detail.groupDetail.recoveryModeSwitchThenResumeSubtitle');
    return t('connectedServices.detail.groupDetail.recoveryModeSwitchOrWaitSubtitle');
}

function formatProbeMinutes(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return String(minutes);
}

function parsePromptNumber(raw: string): number | null {
    const value = Number(raw.trim().replace(/%$/, ''));
    return Number.isFinite(value) ? value : null;
}

function asStringParam(value: unknown): string {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
    return typeof value === 'string' ? value : '';
}

function buildStrategyItems(currentStrategy: GroupStrategy): DropdownMenuItem[] {
    return [
        {
            id: 'priority',
            title: t('connectedServices.detail.groupDetail.strategyPriorityTitle'),
            subtitle: t('connectedServices.detail.groupDetail.strategyPrioritySubtitle'),
            rightElement: currentStrategy === 'priority' ? <StrategyCheckmark /> : null,
        },
        {
            id: 'least_limited',
            title: t('connectedServices.detail.groupDetail.strategyLeastLimitedTitle'),
            subtitle: t('connectedServices.detail.groupDetail.strategyLeastLimitedSubtitle'),
            rightElement: currentStrategy === 'least_limited' ? <StrategyCheckmark /> : null,
        },
        {
            id: 'manual',
            title: t('connectedServices.detail.groupDetail.strategyManualTitle'),
            subtitle: t('connectedServices.detail.groupDetail.strategyManualSubtitle'),
            rightElement: currentStrategy === 'manual' ? <StrategyCheckmark /> : null,
        },
    ];
}

function resolveStrategyTitle(strategy: GroupStrategy): string {
    if (strategy === 'least_limited') return t('connectedServices.detail.groupDetail.strategyLeastLimitedTitle');
    if (strategy === 'manual') return t('connectedServices.detail.groupDetail.strategyManualTitle');
    return t('connectedServices.detail.groupDetail.strategyPriorityTitle');
}

function StrategyCheckmark() {
    const { theme } = useUnistyles();
    return <Ionicons name="checkmark" size={18} color={theme.colors.accent.blue} />;
}

export const ConnectedServiceGroupDetailView = React.memo(function ConnectedServiceGroupDetailView() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const auth = useAuth();
    const profile = useProfile();
    const settings = useSettings();
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const accountFallbackEnabled = useFeatureEnabled('connectedServices.accountFallback');
    const [groups, setGroups] = React.useState<ReadonlyArray<ConnectedServiceAuthGroupV1>>([]);
    const [membersOpen, setMembersOpen] = React.useState(false);
    const [strategyOpen, setStrategyOpen] = React.useState(false);

    const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
    const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
    const rawGroupId = asStringParam((params as Record<string, unknown>).groupId).trim();
    const parsedGroupId = ConnectedServiceAuthGroupIdSchema.safeParse(rawGroupId);
    const groupId = parsedGroupId.success ? parsedGroupId.data : '';
    const credentials = auth.credentials ?? null;
    const serviceLabel = serviceId ? resolveConnectedServiceDisplayName(serviceId, t) : t('connectedServices.fallbackName');
    const svc = serviceId ? (profile.connectedServicesV2.find((candidate) => candidate.serviceId === serviceId) ?? null) : null;
    const profiles = (svc?.profiles ?? []) as ReadonlyArray<ConnectedServiceGroupProfileLike>;
    const group = groups.find((candidate) => candidate.groupId === groupId) ?? null;
    const runtimeGroupCapability = React.useMemo(
        () => serviceId
            ? resolveConnectedServiceRuntimeGroupCapability(serviceId)
            : {
                groupConfigurationSupported: false,
                runtimeFallbackSupported: false,
                groupConfigurationSupportingAgentIds: [],
                runtimeFallbackSupportingAgentIds: [],
            },
        [serviceId],
    );
    const runtimeGroupFallbackSupported = runtimeGroupCapability.runtimeFallbackSupported;
    const fallbackControlsEnabled = accountFallbackEnabled && runtimeGroupFallbackSupported;
    const fallbackDisabledSubtitle = !runtimeGroupFallbackSupported
        ? t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')
        : accountFallbackEnabled
            ? undefined
            : t('connectedServices.detail.groupActions.accountFallbackDisabled');

    const ensureCredentials = () => {
        if (!auth.credentials) {
            throw new Error('Not authenticated');
        }
        return auth.credentials;
    };

    const loadGroups = React.useCallback(async () => {
        if (!serviceId || !credentials || !connectedServicesEnabled || !accountGroupsEnabled) {
            setGroups([]);
            return [];
        }
        const nextGroups = await listConnectedServiceAuthGroupsV3(credentials, { serviceId });
        setGroups(nextGroups);
        return nextGroups;
    }, [accountGroupsEnabled, connectedServicesEnabled, credentials, serviceId]);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const nextGroups = await loadGroups();
                if (!cancelled) setGroups(nextGroups);
            } catch {
                if (!cancelled) setGroups([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadGroups]);

    const upsertGroup = React.useCallback((nextGroup: ConnectedServiceAuthGroupV1) => {
        setGroups((prev) => {
            const index = prev.findIndex((candidate) => candidate.groupId === nextGroup.groupId);
            if (index === -1) return [...prev, nextGroup];
            const next = [...prev];
            next[index] = nextGroup;
            return next;
        });
    }, []);

    const runGroupMutation = async (
        mutation: () => Promise<ConnectedServiceAuthGroupV1>,
        opts?: Readonly<{ onError?: (error: unknown) => Promise<boolean> }>,
    ) => {
        try {
            const nextGroup = await mutation();
            upsertGroup(nextGroup);
            await sync.refreshProfile().catch(() => undefined);
            await loadGroups().catch(() => undefined);
        } catch (e: unknown) {
            if (await opts?.onError?.(e)) return;
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        }
    };

    const handleEditName = async () => {
        if (!serviceId || !group) return;
        const next = await Modal.prompt(
            t('connectedServices.detail.groupDetail.nameTitle'),
            t('connectedServices.detail.groupDetail.namePromptBody'),
            {
                placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
                defaultValue: group.displayName ?? group.groupId,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next !== 'string') return;
        const displayName = next.trim() || null;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { displayName },
        }));
    };

    const handleSetAutoSwitch = async (autoSwitch: boolean) => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { autoSwitch }, expectedGeneration: group.generation },
        }));
    };

    const handleSetStrategy = async (strategy: string) => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        if (strategy !== 'priority' && strategy !== 'least_limited' && strategy !== 'manual') return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { strategy }, expectedGeneration: group.generation },
        }));
    };

    const handleEditSoftSwitchRemainingPercent = async () => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        const current = resolveConnectedServiceGroupSoftSwitchRemainingPercent(group);
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptTitle'),
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptBody'),
            {
                placeholder: String(CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.softSwitchRemainingPercent),
                defaultValue: String(current),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof raw !== 'string') return;
        const value = parsePromptNumber(raw);
        if (value === null || value < 0 || value > 100) {
            await Modal.alert(
                t('connectedServices.detail.groupDetail.invalidSoftSwitchThresholdTitle'),
                t('connectedServices.detail.groupDetail.invalidSoftSwitchThresholdBody'),
            );
            return;
        }
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { softSwitchRemainingPercent: value }, expectedGeneration: group.generation },
        }));
    };

    const handleEditProbeIfSnapshotOlderThan = async () => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        const currentMinutes = formatProbeMinutes(resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs(group));
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.staleProbePromptTitle'),
            t('connectedServices.detail.groupDetail.staleProbePromptBody'),
            {
                placeholder: formatProbeMinutes(CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.probeIfSnapshotOlderThanMs),
                defaultValue: currentMinutes,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof raw !== 'string') return;
        const minutes = parsePromptNumber(raw);
        if (minutes === null || minutes < 1) {
            await Modal.alert(
                t('connectedServices.detail.groupDetail.invalidStaleProbeTitle'),
                t('connectedServices.detail.groupDetail.invalidStaleProbeBody'),
            );
            return;
        }
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { probeIfSnapshotOlderThanMs: Math.round(minutes * 60_000) }, expectedGeneration: group.generation },
        }));
    };

    const handleSetActiveMember = async (profileId: string) => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        const runSetActiveMember = async (overrideRuntimeCooldown: boolean) => {
            await runGroupMutation(() => setConnectedServiceAuthGroupActiveProfileV3(ensureCredentials(), {
                serviceId,
                groupId: group.groupId,
                profileId,
                expectedGeneration: group.generation,
                ...(overrideRuntimeCooldown ? { overrideRuntimeCooldown: true } : {}),
            }));
        };
        await runGroupMutation(() => setConnectedServiceAuthGroupActiveProfileV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            expectedGeneration: group.generation,
        }), {
            onError: async (error) => {
                if (!isConnectedServiceRuntimeCooldownError(error)) return false;
                const prompt = resolveConnectedServiceRuntimeCooldownOverridePrompt(error);
                const ok = await Modal.confirm(prompt.title, prompt.body, {
                    confirmText: prompt.confirmText,
                    cancelText: prompt.cancelText,
                });
                if (!ok) return true;
                await runSetActiveMember(true);
                return true;
            },
        });
    };

    const handleSetMemberEnabled = async (profileId: string, enabled: boolean) => {
        if (!serviceId || !group) return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            patch: { enabled, expectedGeneration: group.generation },
        }));
    };

    const handleEditMemberPriority = async (member: ConnectedServiceGroupMemberViewModel) => {
        if (!serviceId || !group) return;
        const next = await Modal.prompt(
            t('connectedServices.detail.groupActions.priorityTitle'),
            t('connectedServices.detail.groupActions.priorityBody'),
            {
                placeholder: String(member.priority),
                defaultValue: String(member.priority),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next !== 'string') return;
        const priority = Number.parseInt(next.trim(), 10);
        if (!Number.isFinite(priority)) {
            await Modal.alert(
                t('connectedServices.detail.groupActions.invalidPriorityTitle'),
                t('connectedServices.detail.groupActions.invalidPriorityBody'),
            );
            return;
        }
        await runGroupMutation(() => patchConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId: member.profileId,
            patch: { priority, expectedGeneration: group.generation },
        }));
    };

    const handleToggleMember = async (profileId: string) => {
        if (!serviceId || !group) return;
        const existing = group.members.some((member) => member.profileId === profileId);
        if (existing) {
            const memberLabel = resolveConnectedServiceGroupMemberIdentity({
                serviceId,
                profileId,
                labelsByKey: settings.connectedServicesProfileLabelByKey,
                profiles,
            }).diagnosticLabel;
            const ok = await Modal.confirm(
                t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
                t('connectedServices.detail.groupActions.removeMemberConfirmBody', { profileId: memberLabel }),
                { confirmText: t('common.remove'), cancelText: t('common.cancel') },
            );
            if (!ok) return;
            await runGroupMutation(() => removeConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
                serviceId,
                groupId: group.groupId,
                profileId,
                expectedGeneration: group.generation,
            }));
            return;
        }
        await runGroupMutation(() => addConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            priority: 100,
            enabled: true,
            expectedGeneration: group.generation,
        }));
    };

    if (!connectedServicesEnabled || !accountGroupsEnabled) {
        return (
            <ItemList>
                <ItemGroup title={t('settings.connectedAccounts')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>{t('settings.connectedAccountsDisabled')}</Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    if (!serviceId || !groupId) {
        return (
            <ItemList>
                <ItemGroup title={t('connectedServices.title')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.oauthPaste.invalidConfig')}</Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    if (!group) {
        return (
            <ItemList>
                <ItemGroup title={t('connectedServices.detail.groupDetail.missingTitle')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {t('connectedServices.detail.groupDetail.missingBody', { service: serviceLabel, groupId })}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    const label = group.displayName ?? group.groupId;
    const softSwitchRemainingPercent = resolveConnectedServiceGroupSoftSwitchRemainingPercent(group);
    const staleProbeMinutes = formatProbeMinutes(resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs(group));
    const switchBudget = resolveConnectedServiceGroupSwitchBudget(group);
    const recoveryMode = resolveConnectedServiceGroupRecoveryMode(group);
    const autoSwitchSubtitle = fallbackDisabledSubtitle
        ? fallbackDisabledSubtitle
        : group.policy.autoSwitch
            ? t('connectedServices.detail.groupDetail.autoSwitchEnabledSubtitle')
            : t('connectedServices.detail.groupDetail.autoSwitchDisabledSubtitle');
    const memberItems = profiles.flatMap((candidate): DropdownMenuItem[] => {
        const profileId = readConnectedServiceGroupString(candidate.profileId);
        if (!profileId) return [];
        const isMember = group.members.some((member) => member.profileId === profileId);
        return [{
            id: profileId,
            testID: `connected-services-group-detail:member-option:${profileId}`,
            title: resolveConnectedServiceGroupProfileTitle({
                serviceId,
                profileId,
                labelsByKey: settings.connectedServicesProfileLabelByKey,
            }),
            subtitle: candidate.providerEmail ?? profileId,
            rightElement: isMember ? <Ionicons name="checkmark" size={18} color={theme.colors.accent.blue} /> : null,
        }];
    });
    const enabledCount = group.members.filter((member) => member.enabled).length;

    return (
        <ItemList>
            <ItemGroup title={`${serviceLabel} • ${label}`}>
                <Item
                    testID="connected-services-group-detail:name"
                    title={t('connectedServices.detail.groupDetail.nameTitle')}
                    subtitle={label}
                    icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
                    onPress={() => void handleEditName()}
                />
                <Item
                    title={t('connectedServices.detail.groupDetail.groupIdTitle')}
                    subtitle={group.groupId}
                    showChevron={false}
                />
                <DropdownMenu
                    open={membersOpen}
                    onOpenChange={setMembersOpen}
                    items={memberItems}
                    closeOnSelect={false}
                    selectedId={group.activeProfileId}
                    search
                    searchPlaceholder={t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
                    emptyLabel={t('connectedServices.detail.groupActions.noProfilesAvailable')}
                    onSelect={(profileId) => void handleToggleMember(profileId)}
                    itemTrigger={{
                        title: t('connectedServices.detail.groupDetail.membersTitle'),
                        subtitle: t('connectedServices.detail.groupDetail.membersSubtitle', {
                            enabled: enabledCount,
                            total: group.members.length,
                        }),
                        icon: <Ionicons name="people-outline" size={22} color={theme.colors.accent.blue} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        itemProps: {
                            testID: 'connected-services-group-detail:members',
                            disabled: memberItems.length === 0,
                        },
                    }}
                    rowKind="item"
                    variant="selectable"
                />
            </ItemGroup>

            {group.members.length > 0 ? (
                <ItemGroup title={t('connectedServices.detail.groupActions.membersTitle')}>
                    {group.members
                        .slice()
                        .sort((a, b) => {
                            if (a.priority !== b.priority) return a.priority - b.priority;
                            return a.profileId.localeCompare(b.profileId);
                        })
                        .map((member) => {
                            const memberModel = normalizeConnectedServiceGroupMember(member);
                            if (!memberModel) return null;
                            return (
                                <Item
                                    key={memberModel.profileId}
                                    testID={`connected-services-group-detail:member:${memberModel.profileId}`}
                                    title={resolveConnectedServiceGroupProfileTitle({
                                        serviceId,
                                        profileId: memberModel.profileId,
                                        labelsByKey: settings.connectedServicesProfileLabelByKey,
                                    })}
                                    subtitle={formatConnectedServiceGroupMemberSubtitle(memberModel, group.activeProfileId)}
                                    icon={(
                                        <Ionicons
                                            name={memberModel.profileId === group.activeProfileId ? 'radio-button-on-outline' : 'person-circle-outline'}
                                            size={22}
                                            color={memberModel.enabled ? theme.colors.button.secondary.tint : theme.colors.text.tertiary}
                                        />
                                    )}
                                    rightElement={(
                                        <ItemRowActions
                                            title={memberModel.profileId}
                                            compactActionIds={[`connected-services-group:${group.groupId}:member:${memberModel.profileId}:action:set-active`]}
                                            iconSize={18}
                                            overflowTriggerTestID={`connected-services-group-detail:member:${memberModel.profileId}:actions`}
                                            actions={buildConnectedServiceGroupMemberActions({
                                                groupId: group.groupId,
                                                activeProfileId: group.activeProfileId,
                                                member: memberModel,
                                                accountFallbackEnabled: fallbackControlsEnabled,
                                                accountFallbackDisabledSubtitle: fallbackDisabledSubtitle,
                                                onSetActiveMember: (profileId) => void handleSetActiveMember(profileId),
                                                onSetMemberEnabled: (targetMember, enabled) => void handleSetMemberEnabled(targetMember.profileId, enabled),
                                                onEditMemberPriority: (targetMember) => void handleEditMemberPriority(targetMember),
                                                onRemoveMember: (targetMember) => void handleToggleMember(targetMember.profileId),
                                            })}
                                        />
                                    )}
                                    showChevron={false}
                                />
                            );
                        })}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('connectedServices.detail.groupDetail.optionsTitle')}>
                <Item
                    testID="connected-services-group-detail:auto-switch"
                    title={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                    subtitle={autoSwitchSubtitle}
                    icon={<Ionicons name="swap-horizontal-outline" size={22} color={theme.colors.accent.blue} />}
                    disabled={!fallbackControlsEnabled}
                    onPress={fallbackControlsEnabled ? () => void handleSetAutoSwitch(!group.policy.autoSwitch) : undefined}
                />
                <DropdownMenu
                    open={strategyOpen}
                    onOpenChange={setStrategyOpen}
                    items={buildStrategyItems(group.policy.strategy)}
                    selectedId={group.policy.strategy}
                    onSelect={(strategy) => void handleSetStrategy(strategy)}
                    itemTrigger={{
                        title: t('connectedServices.detail.groupDetail.strategyTitle'),
                        subtitle: resolveStrategyTitle(group.policy.strategy),
                        icon: <Ionicons name="options-outline" size={22} color={theme.colors.accent.blue} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        itemProps: {
                            testID: 'connected-services-group-detail:strategy',
                            disabled: !fallbackControlsEnabled,
                        },
                    }}
                    rowKind="item"
                    variant="selectable"
                />
                <Item
                    testID="connected-services-group-detail:soft-switch-threshold"
                    title={t('connectedServices.detail.groupDetail.softSwitchThresholdTitle')}
                    subtitle={fallbackDisabledSubtitle ?? t('connectedServices.detail.groupDetail.softSwitchThresholdSubtitle', { percent: String(softSwitchRemainingPercent) })}
                    icon={<Ionicons name="speedometer-outline" size={22} color={theme.colors.accent.indigo} />}
                    disabled={!fallbackControlsEnabled}
                    onPress={fallbackControlsEnabled ? () => void handleEditSoftSwitchRemainingPercent() : undefined}
                />
                <Item
                    testID="connected-services-group-detail:stale-probe-after"
                    title={t('connectedServices.detail.groupDetail.staleProbeTitle')}
                    subtitle={fallbackDisabledSubtitle ?? t('connectedServices.detail.groupDetail.staleProbeSubtitle', { minutes: staleProbeMinutes })}
                    icon={<Ionicons name="refresh-circle-outline" size={22} color={theme.colors.accent.indigo} />}
                    disabled={!fallbackControlsEnabled}
                    onPress={fallbackControlsEnabled ? () => void handleEditProbeIfSnapshotOlderThan() : undefined}
                />
                <Item
                    testID="connected-services-group-detail:switch-budget"
                    title={t('connectedServices.detail.groupDetail.switchBudgetTitle')}
                    subtitle={t('connectedServices.detail.groupDetail.switchBudgetSubtitle', {
                        perTurn: String(switchBudget.perTurn),
                        perHour: String(switchBudget.perSessionHour),
                    })}
                    icon={<Ionicons name="repeat-outline" size={22} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
                <Item
                    testID="connected-services-group-detail:recovery-mode"
                    title={t('connectedServices.detail.groupDetail.recoveryModeTitle')}
                    subtitle={resolveRecoveryModeSubtitle(recoveryMode)}
                    icon={<Ionicons name="medkit-outline" size={22} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
                <Item
                    title={t('connectedServices.detail.groupDetail.recoveryPromptTitle')}
                    subtitle={t('connectedServices.detail.groupDetail.recoveryPromptSubtitle')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
