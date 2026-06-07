import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import {
    type ConnectedServiceId,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { t } from '@/text';

import { ConnectedServiceQuotaBadgesView } from '../ConnectedServiceQuotaBadgesView';
import {
    buildConnectedServiceGroupMemberActions,
    formatConnectedServiceGroupMemberSubtitle,
    formatConnectedServiceGroupSubtitle,
    parseConnectedServiceGroupViewModels,
    readConnectedServiceGroupString,
    resolveConnectedServiceGroupMissingEligibleWarning,
    resolveConnectedServiceGroupProfileTitle,
    type ConnectedServiceGroupProfileLike,
    type ConnectedServiceGroupViewModel,
} from '../model/connectedServiceGroupViewModel';

function buildGroupActions(params: Readonly<{
    group: ConnectedServiceGroupViewModel;
    accountFallbackEnabled: boolean;
    onEditGroupLabel: (group: ConnectedServiceGroupViewModel) => void;
    onSetGroupAutoSwitch: (group: ConnectedServiceGroupViewModel, autoSwitch: boolean) => void;
    onSetGroupStrategy: (group: ConnectedServiceGroupViewModel, strategy: 'priority' | 'manual') => void;
    onDeleteGroup: (group: ConnectedServiceGroupViewModel) => void;
}>): ItemAction[] {
    const group = params.group;
    return [
        {
            id: `connected-services-group:${group.groupId}:action:edit`,
            inlineTestID: `connected-services-group:${group.groupId}:action:edit`,
            title: t('connectedServices.detail.groupActions.editTitle'),
            icon: 'pencil-outline',
            onPress: () => params.onEditGroupLabel(group),
        },
        {
            id: group.policy.autoSwitch
                ? `connected-services-group:${group.groupId}:action:disable-fallback`
                : `connected-services-group:${group.groupId}:action:enable-fallback`,
            title: group.policy.autoSwitch
                ? t('connectedServices.detail.groupActions.disableFallback')
                : t('connectedServices.detail.groupActions.enableFallback'),
            subtitle: params.accountFallbackEnabled
                ? undefined
                : t('connectedServices.detail.groupActions.accountFallbackDisabled'),
            icon: group.policy.autoSwitch ? 'pause-circle-outline' : 'swap-horizontal-outline',
            disabled: !params.accountFallbackEnabled,
            onPress: () => params.onSetGroupAutoSwitch(group, !group.policy.autoSwitch),
        },
        {
            id: group.policy.strategy === 'manual'
                ? `connected-services-group:${group.groupId}:action:priority-strategy`
                : `connected-services-group:${group.groupId}:action:manual-strategy`,
            title: group.policy.strategy === 'manual'
                ? t('connectedServices.detail.groupActions.usePriorityStrategy')
                : t('connectedServices.detail.groupActions.useManualStrategy'),
            icon: group.policy.strategy === 'manual' ? 'list-outline' : 'hand-left-outline',
            onPress: () => params.onSetGroupStrategy(group, group.policy.strategy === 'manual' ? 'priority' : 'manual'),
        },
        {
            id: `connected-services-group:${group.groupId}:action:delete`,
            title: t('connectedServices.detail.groupActions.deleteTitle'),
            icon: 'trash-outline',
            destructive: true,
            onPress: () => params.onDeleteGroup(group),
        },
    ];
}

export const ConnectedServiceDetailGroupsGroup = React.memo(function ConnectedServiceDetailGroupsGroup(props: Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceGroupProfileLike>;
    profileLabelsByKey: Readonly<Record<string, string>>;
    pinnedMeterIdsByKey: Readonly<Record<string, ReadonlyArray<string>>>;
    quotaSummaryStrategyByKey: Readonly<Record<string, 'primary' | 'min_remaining' | undefined>>;
    quotaSnapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    quotasEnabled: boolean;
    groups: unknown;
    accountFallbackEnabled: boolean;
    onCreateGroup: () => void;
    onOpenGroup: (groupId: string) => void;
    onSetGroupAutoSwitch: (groupId: string, autoSwitch: boolean) => void;
    onSetGroupStrategy: (groupId: string, strategy: 'priority' | 'manual') => void;
    onDeleteGroup: (groupId: string, label: string) => void;
    onAddMember: (groupId: string, profileId: string) => void;
    onSetActiveMember: (groupId: string, profileId: string, expectedGeneration: number) => void;
    onSetMemberEnabled: (groupId: string, profileId: string, enabled: boolean) => void;
    onEditMemberPriority: (groupId: string, profileId: string, currentPriority: number) => void;
    onRemoveMember: (groupId: string, profileId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const groupModels = React.useMemo(() => parseConnectedServiceGroupViewModels(props.groups), [props.groups]);
    const [openMembersGroupId, setOpenMembersGroupId] = React.useState<string | null>(null);

    return (
        <>
            <ItemGroup title={t('connectedServices.detail.groups.title')}>
                {groupModels.length === 0 ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.detail.groups.empty')}</Text>
                    </View>
                ) : null}
                {groupModels.flatMap((group) => {
                    const iconName = group.status === 'ready' ? 'git-network-outline' : 'warning-outline';
                    const iconColor = group.status === 'ready'
                        ? theme.colors.state.success.foreground
                        : theme.colors.accent.orange;
                    const warning = resolveConnectedServiceGroupMissingEligibleWarning(group);
                    const rows: React.ReactNode[] = [
                        <Item
                            key={`${group.groupId}:summary`}
                            testID={`connected-services-group:${group.groupId}`}
                            title={group.label}
                            subtitle={formatConnectedServiceGroupSubtitle(group, {
                                serviceId: props.serviceId,
                                labelsByKey: props.profileLabelsByKey,
                                profiles: props.profiles,
                            })}
                            icon={<Ionicons name={iconName} size={22} color={iconColor} />}
                            rightElement={(
                                <ItemRowActions
                                    title={group.label}
                                    compactActionIds={[`connected-services-group:${group.groupId}:action:edit`]}
                                    iconSize={18}
                                    overflowTriggerTestID={`connected-services-group:${group.groupId}:actions`}
                                    actions={buildGroupActions({
                                        group,
                                        accountFallbackEnabled: props.accountFallbackEnabled,
                                        onEditGroupLabel: (target) => props.onOpenGroup(target.groupId),
                                        onSetGroupAutoSwitch: (target, autoSwitch) => props.onSetGroupAutoSwitch(target.groupId, autoSwitch),
                                        onSetGroupStrategy: (target, strategy) => props.onSetGroupStrategy(target.groupId, strategy),
                                        onDeleteGroup: (target) => props.onDeleteGroup(target.groupId, target.label),
                                    })}
                                />
                            )}
                            showChevron={false}
                        />,
                    ];

                    if (warning) {
                        rows.push(
                            <Item
                                key={`${group.groupId}:warning`}
                                testID={`connected-services-group:${group.groupId}:warning`}
                                title={warning}
                                icon={<Ionicons name="warning-outline" size={22} color={theme.colors.accent.orange} />}
                                mode="info"
                                showChevron={false}
                            />,
                        );
                    }

                    for (const member of group.members) {
                        const quotaKey = connectedServiceProfileKey({ serviceId: props.serviceId, profileId: member.profileId });
                        const rawStrategy = props.quotaSummaryStrategyByKey[quotaKey];
                        const badges = props.quotasEnabled
                            ? computeConnectedServiceQuotaSummaryBadges({
                                snapshot: props.quotaSnapshotsByKey[quotaKey] ?? null,
                                pinnedMeterIds: props.pinnedMeterIdsByKey[quotaKey] ?? [],
                                strategy: rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary',
                            })
                            : [];
                        rows.push(
                            <Item
                                key={`${group.groupId}:member:${member.profileId}`}
                                testID={`connected-services-group:${group.groupId}:member:${member.profileId}`}
                                title={resolveConnectedServiceGroupProfileTitle({
                                    serviceId: props.serviceId,
                                    profileId: member.profileId,
                                    labelsByKey: props.profileLabelsByKey,
                                    profiles: props.profiles,
                                })}
                                subtitle={formatConnectedServiceGroupMemberSubtitle(member, group.activeProfileId, {
                                    serviceId: props.serviceId,
                                    labelsByKey: props.profileLabelsByKey,
                                    profiles: props.profiles,
                                })}
                                icon={(
                                    <Ionicons
                                        name={member.profileId === group.activeProfileId ? 'radio-button-on-outline' : 'person-circle-outline'}
                                        size={22}
                                        color={member.enabled ? theme.colors.button.secondary.tint : theme.colors.text.tertiary}
                                    />
                                )}
                                rightElement={(
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                        {props.quotasEnabled ? <ConnectedServiceQuotaBadgesView badges={badges} /> : null}
                                        <ItemRowActions
                                            title={member.profileId}
                                            compactActionIds={[`connected-services-group:${group.groupId}:member:${member.profileId}:action:set-active`]}
                                            iconSize={18}
                                            overflowTriggerTestID={`connected-services-group:${group.groupId}:member:${member.profileId}:actions`}
                                            actions={buildConnectedServiceGroupMemberActions({
                                                groupId: group.groupId,
                                                activeProfileId: group.activeProfileId,
                                                member,
                                                accountFallbackEnabled: props.accountFallbackEnabled,
                                                onSetActiveMember: (profileId) => props.onSetActiveMember(group.groupId, profileId, group.generation),
                                                onSetMemberEnabled: (targetMember, enabled) => props.onSetMemberEnabled(group.groupId, targetMember.profileId, enabled),
                                                onEditMemberPriority: (targetMember) => props.onEditMemberPriority(group.groupId, targetMember.profileId, targetMember.priority),
                                                onRemoveMember: (targetMember) => props.onRemoveMember(group.groupId, targetMember.profileId),
                                            })}
                                        />
                                    </View>
                                )}
                                showChevron={false}
                            />,
                        );
                    }

                    const selectableProfiles = props.profiles.flatMap((profile): DropdownMenuItem[] => {
                        const profileId = readConnectedServiceGroupString(profile.profileId);
                        if (!profileId) return [];
                        const label = resolveConnectedServiceGroupProfileTitle({
                            serviceId: props.serviceId,
                            profileId,
                            labelsByKey: props.profileLabelsByKey,
                            profiles: props.profiles,
                        });
                        const member = group.members.find((candidate) => candidate.profileId === profileId) ?? null;
                        return [{
                            id: profileId,
                            testID: `connected-services-group:${group.groupId}:member-option:${profileId}`,
                            title: label,
                            subtitle: profile.providerEmail ?? profileId,
                            rightElement: member ? <Ionicons name="checkmark" size={18} color={theme.colors.accent.blue} /> : null,
                        }];
                    });
                    rows.push(
                        <DropdownMenu
                            key={`${group.groupId}:add-member`}
                            open={openMembersGroupId === group.groupId}
                            onOpenChange={(open) => setOpenMembersGroupId(open ? group.groupId : null)}
                            items={selectableProfiles}
                            closeOnSelect={false}
                            selectedId={group.activeProfileId || null}
                            search
                            searchPlaceholder={t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
                            emptyLabel={t('connectedServices.detail.groupActions.noProfilesAvailable')}
                            onSelect={(profileId) => {
                                const existing = group.members.some((member) => member.profileId === profileId);
                                if (existing) {
                                    props.onRemoveMember(group.groupId, profileId);
                                    return;
                                }
                                props.onAddMember(group.groupId, profileId);
                            }}
                            itemTrigger={{
                                title: t('connectedServices.detail.groupActions.membersTitle'),
                                subtitle: selectableProfiles.length > 0
                                    ? t('connectedServices.detail.groupActions.membersSubtitle')
                                    : t('connectedServices.detail.groupActions.noProfilesAvailable'),
                                icon: <Ionicons name="people-outline" size={22} color={theme.colors.accent.blue} />,
                                showSelectedDetail: false,
                                showSelectedSubtitle: false,
                                itemProps: {
                                    testID: `connected-services-group:${group.groupId}:members`,
                                    disabled: selectableProfiles.length === 0,
                                },
                            }}
                            rowKind="item"
                            variant="selectable"
                        />,
                    );

                    return rows;
                })}
            </ItemGroup>
            <ItemGroup title={t('connectedServices.detail.groupActions.title')}>
                <Item
                    testID="connected-services-action:create-group"
                    title={t('connectedServices.detail.groupActions.createTitle')}
                    subtitle={t('connectedServices.detail.groupActions.createSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
                    onPress={props.onCreateGroup}
                />
            </ItemGroup>
        </>
    );
});
