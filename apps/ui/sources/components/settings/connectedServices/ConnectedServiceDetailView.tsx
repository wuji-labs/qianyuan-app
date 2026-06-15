import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { deleteConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { deriveConnectedServiceAuthGroupIdFromName } from '@/sync/domains/connectedServices/deriveConnectedServiceAuthGroupIdFromName';
import {
  addConnectedServiceAuthGroupMemberV3,
  createConnectedServiceAuthGroupV3,
  deleteConnectedServiceAuthGroupV3,
  listConnectedServiceAuthGroupsV3,
  patchConnectedServiceAuthGroupMemberV3,
  patchConnectedServiceAuthGroupV3,
  removeConnectedServiceAuthGroupMemberV3,
  setConnectedServiceAuthGroupActiveProfileV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  type ConnectedServiceId,
  type ConnectedServiceAuthGroupV1,
} from '@happier-dev/protocol';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { ConnectedServiceDetailActionsGroup } from './detail/ConnectedServiceDetailActionsGroup';
import { ConnectedServiceDetailGroupsGroup } from './detail/ConnectedServiceDetailGroupsGroup';
import { ConnectedServiceDetailProfilesGroup } from './detail/ConnectedServiceDetailProfilesGroup';
import { ConnectedServiceDetailQuotasSection } from './detail/ConnectedServiceDetailQuotasSection';
import {
  isConnectedServiceCredentialReferencedByGroupError,
  isConnectedServiceRuntimeCooldownError,
  resolveConnectedServiceRuntimeCooldownOverridePrompt,
  resolveConnectedServiceSettingsErrorMessage,
} from './errors/connectedServiceSettingsErrors';
import { resolveConnectedServiceRuntimeGroupCapability } from './model/connectedServiceRuntimeFallbackCapability';
import { resolveConnectedServiceProfileIdentityDisplay } from './model/resolveConnectedServiceIdentityDisplay';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import {
  formatConnectedServiceProfileGroupReferenceLabels,
  resolveConnectedServiceProfileGroupReferenceLabels,
} from './model/resolveConnectedServiceProfileGroupReferences';
import { resolveConnectedServiceGroupMemberIdentity } from './model/connectedServiceGroupViewModel';
import { resolveConnectedServiceOauthAddActionModesForPlatform } from './oauth/resolveConnectedServiceOauthAddActionModesForPlatform';
import { promptConnectedServiceTokenValue } from './promptConnectedServiceTokenValue';
import { storeConnectedServiceCredentialWithIdentityConfirmation } from './storeConnectedServiceCredentialWithIdentityConfirmation';
import { runConnectedServiceCredentialStoredEffects } from './runConnectedServiceCredentialStoredEffects';
import {
  invalidateConnectedServiceGroupsRefreshSignal,
  useConnectedServiceGroupsRefreshSignal,
} from './connectedServiceGroupsRefreshSignal';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function resolveConnectedServiceProjectionSignature(service: Readonly<{
  profiles?: ReadonlyArray<Readonly<{
    profileId?: string;
    status?: string;
    kind?: string | null;
    providerEmail?: string | null;
  }>>;
  groups?: ReadonlyArray<Readonly<{
    groupId?: string;
    displayName?: string | null;
    activeProfileId?: string | null;
    generation?: number;
    memberProfileIds?: ReadonlyArray<string>;
  }>>;
}> | null): string {
  if (!service) return '';

  return JSON.stringify({
    groups: (service.groups ?? []).map((group) => ({
      activeProfileId: group.activeProfileId ?? null,
      displayName: group.displayName ?? '',
      generation: group.generation ?? 0,
      groupId: group.groupId ?? '',
      memberProfileIds: [...(group.memberProfileIds ?? [])],
    })),
    profiles: (service.profiles ?? []).map((profile) => ({
      kind: profile.kind ?? null,
      profileId: profile.profileId ?? '',
      providerEmail: profile.providerEmail ?? null,
      status: profile.status ?? '',
    })),
  });
}

function clearAuthoritativeGroupsIfNeeded(
  groups: ReadonlyArray<ConnectedServiceAuthGroupV1>,
): ReadonlyArray<ConnectedServiceAuthGroupV1> {
  return groups.length === 0 ? groups : [];
}

export const ConnectedServiceDetailView = React.memo(function ConnectedServiceDetailView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const accountFallbackEnabled = useFeatureEnabled('connectedServices.accountFallback');
  const profile = useProfile();
  const settings = useSettings();
  const applySettings = useApplySettings();
  const [quotaSnapshotsByKey, setQuotaSnapshotsByKey] = React.useState<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>({});
  const [authoritativeGroups, setAuthoritativeGroups] = React.useState<ReadonlyArray<ConnectedServiceAuthGroupV1>>([]);

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const entry = serviceId ? getConnectedServiceRegistryEntry(serviceId) : null;
  const serviceLabel = serviceId ? resolveConnectedServiceDisplayName(serviceId, t) : t('connectedServices.fallbackName');

  const services = profile.connectedServicesV2;
  const svc = serviceId ? (services.find((s) => s.serviceId === serviceId) ?? null) : null;
  const profiles = svc?.profiles ?? [];
  const defaultProfileIdRaw = serviceId ? settings.connectedServicesDefaultProfileByServiceId[serviceId] : undefined;
  const defaultProfileId = typeof defaultProfileIdRaw === 'string' ? defaultProfileIdRaw.trim() : '';
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
  const authCredentials = auth.credentials ?? null;
  const groupsRefreshSignal = useConnectedServiceGroupsRefreshSignal();
  const serviceProjectionSignature = React.useMemo(
    () => resolveConnectedServiceProjectionSignature(svc),
    [svc],
  );

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const resolveProfileGroupReferenceLabels = React.useCallback((profileId: string) => (
    accountGroupsEnabled
      ? resolveConnectedServiceProfileGroupReferenceLabels({
        profileId,
        groups: authoritativeGroups,
        projectedGroups: svc?.groups,
      })
      : []
  ), [accountGroupsEnabled, authoritativeGroups, svc?.groups]);

  const finishDisconnect = React.useCallback(async (
    profileId: string,
    opts?: Readonly<{ cleanupGroupReferences?: boolean }>,
  ) => {
    const credentials = ensureCredentials();
    await deleteConnectedServiceCredentialForAccount(credentials, {
      serviceId: serviceId!,
      profileId,
      ...(opts?.cleanupGroupReferences ? { cleanupGroupReferences: true } : {}),
    });
    await sync.refreshProfile();
    invalidateConnectedServiceGroupsRefreshSignal();
  }, [serviceId]);

  const promptProfileId = async (opts?: { defaultValue?: string }) => {
    const res = await Modal.prompt(
      t('connectedServices.detail.prompts.profileIdTitle'),
      t('connectedServices.detail.prompts.profileIdBody'),
      {
        placeholder: t('connectedServices.detail.prompts.profileIdPlaceholder'),
        defaultValue: opts?.defaultValue,
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    const profileId = typeof res === 'string' ? res.trim() : '';
    if (!profileId) return null;
    const parsed = ConnectedServiceProfileIdSchema.safeParse(profileId);
    if (!parsed.success) {
      await Modal.alert(
        t('connectedServices.detail.alerts.invalidProfileIdTitle'),
        t('connectedServices.detail.alerts.invalidProfileIdBody'),
      );
      return null;
    }
    return parsed.data;
  };

  const handleDisconnect = async (profileId: string) => {
    const profileRecord = profiles.find((candidate) => candidate.profileId === profileId) ?? null;
    const profileConfirmationLabel = serviceId
      ? resolveConnectedServiceProfileIdentityDisplay({
          profileId,
          label: resolveConnectedServiceProfileLabel({
            labelsByKey: settings.connectedServicesProfileLabelByKey,
            serviceId,
            profileId,
          }),
          providerEmail: typeof profileRecord?.providerEmail === 'string' ? profileRecord.providerEmail : '',
        }).diagnosticLabel
      : profileId;
    const groupReferenceLabels = resolveProfileGroupReferenceLabels(profileId);
    const cleanupGroupReferences = groupReferenceLabels.length > 0;
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      cleanupGroupReferences
        ? t('connectedServices.detail.disconnectGroupCleanupConfirmBody', {
          service: serviceLabel,
          profileId: profileConfirmationLabel,
          groups: formatConnectedServiceProfileGroupReferenceLabels(groupReferenceLabels),
        })
        : t('connectedServices.detail.disconnectConfirmBody', { service: serviceLabel, profileId: profileConfirmationLabel }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    try {
      await finishDisconnect(profileId, { cleanupGroupReferences });
    } catch (e: unknown) {
      if (!cleanupGroupReferences && isConnectedServiceCredentialReferencedByGroupError(e)) {
        const retry = await Modal.confirm(
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryTitle'),
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryBody', { service: serviceLabel, profileId: profileConfirmationLabel }),
          {
            confirmText: t('connectedServices.detail.errors.disconnectGroupCleanupRetryConfirm'),
            cancelText: t('common.cancel'),
          },
        );
        if (retry) {
          try {
            await finishDisconnect(profileId, { cleanupGroupReferences: true });
            return;
          } catch (retryError: unknown) {
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
            return;
          }
        }
        return;
      }
      await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
    }
  };

  const handleConnectOauth = async (profileId: string, method: 'device' | 'paste' | 'browser' | null = null) => {
    if (!serviceId || !entry) return;
    if (!entry?.supportsOauth) {
      await Modal.alert(
        t('connect.unsupported.connectTitle', { name: serviceLabel }),
        t('connect.unsupported.runCommandInTerminalWithCommand', { command: entry.connectCommand }),
        [{ text: t('common.ok'), style: 'cancel' }],
      );
      return;
    }
    try {
      router.push({
        pathname: '/settings/connected-services/oauth',
        params: { serviceId: serviceId!, profileId, ...(method ? { method } : {}) },
      });
    } catch {
      await Modal.alert(
        t('connect.unsupported.connectTitle', { name: serviceLabel }),
        t('connect.unsupported.runCommandInTerminalWithCommand', { command: entry.connectCommand }),
        [{ text: t('common.ok'), style: 'cancel' }],
      );
    }
  };

  const storeTokenProfile = async (profileId: string, tokenValue: string) => {
    if (!serviceId || !entry) return;
    const credentials = ensureCredentials();
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: serviceId!,
      profileId,
      kind: 'token',
      token: {
        token: tokenValue,
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, {
      serviceId: serviceId!,
      profileId,
      record,
    }, { onStored: runConnectedServiceCredentialStoredEffects });
    if (!stored) return;
    await Modal.alert(
      t('connectedServices.oauthPaste.alerts.connectedTitle'),
      t('connectedServices.oauthPaste.alerts.connectedBody', {
        serviceId: serviceLabel,
        profileId,
      }),
    );
  };

  const handleConnectToken = async () => {
    if (!serviceId || !entry) return;
    const profileId = await promptProfileId();
    if (!profileId) return;
    const tokenValue = await promptConnectedServiceTokenValue(entry.tokenKind ?? null);
    if (!tokenValue) return;
    await storeTokenProfile(profileId, tokenValue);
  };

  const handleReplaceToken = async (profileId: string) => {
    if (!serviceId || !entry) return;
    const exists = profiles.some((p) => p?.profileId === profileId && p?.kind === 'token');
    if (!exists) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel }),
      );
      return;
    }
    const tokenValue = await promptConnectedServiceTokenValue(entry.tokenKind ?? null);
    if (!tokenValue) return;
    await storeTokenProfile(profileId, tokenValue);
  };

  const handleOpenTokenSetupUrl = async (url: string) => {
    const ok = await openExternalUrl(url);
    if (!ok) {
      await Modal.alert(
        t('common.error'),
        t('connectedServices.detail.alerts.failedToOpenTokenSetupUrl'),
      );
    }
  };

  const handleAddOauthProfile = async (method: 'device' | 'paste' | 'browser' | null) => {
    const profileId = await promptProfileId();
    if (!profileId) return;
    await handleConnectOauth(profileId, method);
  };

  const handleOpenProfile = (profileId: string) => {
    if (!serviceId) return;
    router.push({
      pathname: '/settings/connected-services/profile',
      params: { serviceId, profileId },
    });
  };

  const handleOpenGroup = (groupId: string) => {
    if (!serviceId) return;
    router.push({
      pathname: '/(app)/settings/connected-services/group',
      params: { serviceId, groupId },
    });
  };

  const handleSetDefaultProfile = async (profileId: string) => {
    if (!serviceId) return;
    const exists = profiles.some((p) => p?.profileId === profileId);
    const nextMap = { ...settings.connectedServicesDefaultProfileByServiceId };
    if (!profileId) {
      delete nextMap[serviceId];
    } else if (exists) {
      nextMap[serviceId] = profileId;
    } else {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel }),
      );
      return;
    }
    applySettings({ connectedServicesDefaultProfileByServiceId: nextMap });
  };

  const handleEditProfileLabel = async (profileId: string) => {
    if (!serviceId) return;
    const exists = profiles.some((p) => p?.profileId === profileId);
    if (!exists) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel }),
      );
      return;
    }
    const key = connectedServiceProfileKey({ serviceId, profileId });
    const currentLabelRaw =
      resolveConnectedServiceProfileLabel({
        labelsByKey: settings.connectedServicesProfileLabelByKey,
        serviceId,
        profileId,
      }) ?? settings.connectedServicesProfileLabelByKey[key];
    const currentLabel = typeof currentLabelRaw === 'string' ? currentLabelRaw : '';
    const next = await Modal.prompt(
      t('connectedServices.detail.prompts.profileLabelTitle'),
      t('connectedServices.detail.prompts.profileLabelBody'),
      {
        placeholder: t('connectedServices.detail.prompts.profileLabelPlaceholder'),
        defaultValue: currentLabel,
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (typeof next !== 'string') return;
    const trimmed = next.trim();

    const nextMap = { ...settings.connectedServicesProfileLabelByKey };
    if (trimmed) nextMap[key] = trimmed;
    else delete nextMap[key];

    applySettings({ connectedServicesProfileLabelByKey: nextMap });
  };

  const setPinnedQuotaMeters = async (profileId: string, nextPinned: ReadonlyArray<string>) => {
    if (!serviceId) return;
    const key = connectedServiceProfileKey({ serviceId, profileId });
    const nextMap = { ...settings.connectedServicesQuotaPinnedMeterIdsByKey };
    if (nextPinned.length === 0) {
      delete nextMap[key];
    } else {
      nextMap[key] = [...nextPinned];
    }
    applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
  };

  const fetchAuthoritativeGroups = React.useCallback(async () => {
    if (!serviceId || !accountGroupsEnabled || !authCredentials) return [];
    return await listConnectedServiceAuthGroupsV3(authCredentials, { serviceId });
  }, [accountGroupsEnabled, authCredentials, serviceId]);

  const refreshAuthoritativeGroups = React.useCallback(async () => {
    const groups = await fetchAuthoritativeGroups();
    setAuthoritativeGroups(groups);
    return groups;
  }, [fetchAuthoritativeGroups]);

  React.useEffect(() => {
    let cancelled = false;

    if (!serviceId || !accountGroupsEnabled || !authCredentials) {
      setAuthoritativeGroups(clearAuthoritativeGroupsIfNeeded);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        setAuthoritativeGroups(clearAuthoritativeGroupsIfNeeded);
        const groups = await fetchAuthoritativeGroups();
        if (!cancelled) setAuthoritativeGroups(groups);
      } catch {
        if (!cancelled) setAuthoritativeGroups(clearAuthoritativeGroupsIfNeeded);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountGroupsEnabled, authCredentials, fetchAuthoritativeGroups, groupsRefreshSignal, serviceId, serviceProjectionSignature]);

  const upsertAuthoritativeGroup = React.useCallback((group: ConnectedServiceAuthGroupV1) => {
    setAuthoritativeGroups((prev) => {
      const existingIndex = prev.findIndex((candidate) => candidate.groupId === group.groupId);
      if (existingIndex === -1) return [...prev, group];
      const next = [...prev];
      next[existingIndex] = group;
      return next;
    });
  }, []);

  const removeAuthoritativeGroup = React.useCallback((groupId: string) => {
    setAuthoritativeGroups((prev) => prev.filter((group) => group.groupId !== groupId));
  }, []);

  const runGroupMutation = async <T,>(
    mutation: () => Promise<T>,
    opts?: Readonly<{
      onSuccess?: (result: T) => void;
      onError?: (error: unknown) => Promise<boolean>;
    }>,
  ) => {
    try {
      const result = await mutation();
      opts?.onSuccess?.(result);
      await sync.refreshProfile().catch(() => undefined);
      await refreshAuthoritativeGroups().catch(() => undefined);
    } catch (e: unknown) {
      if (await opts?.onError?.(e)) return;
      await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
    }
  };

  const runAuthenticatedGroupMutation = async <T,>(
    mutation: (credentials: ReturnType<typeof ensureCredentials>) => Promise<T>,
    opts?: Readonly<{
      onSuccess?: (result: T) => void;
      onError?: (error: unknown) => Promise<boolean>;
    }>,
  ) => {
    await runGroupMutation(() => mutation(ensureCredentials()), opts);
  };

  const promptGroupLabel = async (opts: Readonly<{ currentLabel?: string }> = {}) => {
    const res = await Modal.prompt(
      t('connectedServices.detail.groupActions.displayNameTitle'),
      t('connectedServices.detail.groupActions.displayNameBody'),
      {
        placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
        defaultValue: opts.currentLabel,
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (typeof res !== 'string') return undefined;
    const trimmed = res.trim();
    return trimmed || null;
  };

  const promptMemberProfileId = async () => {
    const res = await Modal.prompt(
      t('connectedServices.detail.groupActions.memberProfileTitle'),
      t('connectedServices.detail.groupActions.memberProfileBody'),
      {
        placeholder: t('connectedServices.detail.prompts.profileIdPlaceholder'),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    const profileId = typeof res === 'string' ? res.trim() : '';
    if (!profileId) return null;
    const parsed = ConnectedServiceProfileIdSchema.safeParse(profileId);
    if (!parsed.success) {
      await Modal.alert(
        t('connectedServices.detail.alerts.invalidProfileIdTitle'),
        t('connectedServices.detail.alerts.invalidProfileIdBody'),
      );
      return null;
    }
    if (!profiles.some((candidate) => candidate.profileId === parsed.data)) {
      await Modal.alert(
        t('connectedServices.detail.alerts.unknownProfileTitle'),
        t('connectedServices.detail.alerts.unknownProfileBody', { profileId: parsed.data, service: serviceLabel }),
      );
      return null;
    }
    return parsed.data;
  };

  const handleCreateGroup = async () => {
    if (!serviceId || !accountGroupsEnabled || !runtimeGroupFallbackSupported) return;
    const res = await Modal.prompt(
      t('connectedServices.detail.groupActions.createTitle'),
      t('connectedServices.detail.groupActions.createSubtitle'),
      {
        placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
        confirmText: t('common.create'),
        cancelText: t('common.cancel'),
      },
    );
    const displayName = typeof res === 'string' ? res.trim() : '';
    if (!displayName) return;
    const existingGroupIds = authoritativeGroups.map((group) => group.groupId);
    const groupId = deriveConnectedServiceAuthGroupIdFromName({
      name: displayName,
      existingGroupIds,
    }) ?? deriveConnectedServiceAuthGroupIdFromName({
      name: 'group',
      existingGroupIds,
    });
    if (!groupId) {
      await Modal.alert(
        t('connectedServices.detail.groupActions.invalidGroupIdTitle'),
        t('connectedServices.detail.groupActions.invalidGroupIdBody'),
      );
      return;
    }
    await runAuthenticatedGroupMutation(
      async (credentials) => createConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        displayName,
        members: [],
        activeProfileId: null,
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleEditGroupLabel = async (groupId: string, currentLabel: string) => {
    if (!serviceId) return;
    const displayName = await promptGroupLabel({ currentLabel });
    if (displayName === undefined) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => patchConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        patch: { displayName },
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleSetGroupAutoSwitch = async (groupId: string, autoSwitch: boolean) => {
    if (!serviceId || !runtimeGroupFallbackSupported || !accountFallbackEnabled) return;
    const group = authoritativeGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => patchConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        patch: { policy: { autoSwitch }, expectedGeneration: group.generation },
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleSetGroupStrategy = async (groupId: string, strategy: 'priority' | 'manual') => {
    if (!serviceId || !runtimeGroupFallbackSupported || !accountFallbackEnabled) return;
    const group = authoritativeGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => patchConnectedServiceAuthGroupV3(credentials, {
        serviceId,
        groupId,
        patch: { policy: { strategy }, expectedGeneration: group.generation },
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleDeleteGroup = async (groupId: string, label: string) => {
    if (!serviceId) return;
    const ok = await Modal.confirm(
      t('connectedServices.detail.groupActions.deleteConfirmTitle'),
      t('connectedServices.detail.groupActions.deleteConfirmBody', { group: label }),
      { confirmText: t('common.delete'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => deleteConnectedServiceAuthGroupV3(credentials, { serviceId, groupId }),
      { onSuccess: (didDelete) => { if (didDelete) removeAuthoritativeGroup(groupId); } },
    );
  };

  const handleAddMember = async (groupId: string, profileId: string) => {
    if (!serviceId) return;
    const group = authoritativeGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => addConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        priority: 100,
        enabled: true,
        expectedGeneration: group.generation,
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleSetActiveMember = async (groupId: string, profileId: string, expectedGeneration: number) => {
    if (!serviceId || !runtimeGroupFallbackSupported || !accountFallbackEnabled) return;
    const runSetActiveMember = async (overrideRuntimeCooldown: boolean) => {
      await runAuthenticatedGroupMutation(
        async (credentials) => setConnectedServiceAuthGroupActiveProfileV3(credentials, {
          serviceId,
          groupId,
          profileId,
          expectedGeneration,
          ...(overrideRuntimeCooldown ? { overrideRuntimeCooldown: true } : {}),
        }),
        { onSuccess: upsertAuthoritativeGroup },
      );
    };
    await runAuthenticatedGroupMutation(
      async (credentials) => setConnectedServiceAuthGroupActiveProfileV3(credentials, {
        serviceId,
        groupId,
        profileId,
        expectedGeneration,
      }),
      {
        onSuccess: upsertAuthoritativeGroup,
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
      },
    );
  };

  const handleSetMemberEnabled = async (groupId: string, profileId: string, enabled: boolean) => {
    if (!serviceId) return;
    const group = authoritativeGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) return;
    await runAuthenticatedGroupMutation(
      async (credentials) => patchConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        patch: { enabled, expectedGeneration: group.generation },
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleEditMemberPriority = async (groupId: string, profileId: string, currentPriority: number) => {
    if (!serviceId) return;
    const group = authoritativeGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) return;
    const res = await Modal.prompt(
      t('connectedServices.detail.groupActions.priorityTitle'),
      t('connectedServices.detail.groupActions.priorityBody'),
      {
        placeholder: String(currentPriority),
        defaultValue: String(currentPriority),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (typeof res !== 'string') return;
    const priority = Number.parseInt(res.trim(), 10);
    if (!Number.isFinite(priority)) {
      await Modal.alert(
        t('connectedServices.detail.groupActions.invalidPriorityTitle'),
        t('connectedServices.detail.groupActions.invalidPriorityBody'),
      );
      return;
    }
    await runAuthenticatedGroupMutation(
      async (credentials) => patchConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        patch: { priority, expectedGeneration: group.generation },
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  const handleRemoveMember = async (groupId: string, profileId: string) => {
    if (!serviceId) return;
    const group = authoritativeGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) return;
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
    await runAuthenticatedGroupMutation(
      async (credentials) => removeConnectedServiceAuthGroupMemberV3(credentials, {
        serviceId,
        groupId,
        profileId,
        expectedGeneration: group.generation,
      }),
      { onSuccess: upsertAuthoritativeGroup },
    );
  };

  if (!connectedServicesEnabled) {
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

  if (!serviceId || !entry) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.detail.unknownService')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  const oauthAddActionModes = resolveConnectedServiceOauthAddActionModesForPlatform({
    platformOS: Platform.OS,
    oauthAddActionModes: entry.oauthAddActionModes,
  });

  return (
    <ItemList>
      <ConnectedServiceDetailProfilesGroup
        title={serviceLabel}
        serviceId={serviceId}
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
        pinnedMeterIdsByKey={settings.connectedServicesQuotaPinnedMeterIdsByKey}
        quotaSummaryStrategyByKey={settings.connectedServicesQuotaSummaryStrategyByKey}
        quotaSnapshotsByKey={quotaSnapshotsByKey}
        quotasEnabled={quotasEnabled}
        onDisconnect={(profileId) => void handleDisconnect(profileId)}
        onConnectOauth={(profileId) => void handleConnectOauth(profileId)}
        onReplaceToken={(profileId) => void handleReplaceToken(profileId)}
        onOpenProfile={(profileId) => handleOpenProfile(profileId)}
        onSetDefaultProfile={(profileId) => void handleSetDefaultProfile(profileId)}
        onEditProfileLabel={(profileId) => void handleEditProfileLabel(profileId)}
      />

      {accountGroupsEnabled ? (
        <ConnectedServiceDetailGroupsGroup
          serviceId={serviceId}
          profiles={profiles}
          profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
          pinnedMeterIdsByKey={settings.connectedServicesQuotaPinnedMeterIdsByKey}
          quotaSummaryStrategyByKey={settings.connectedServicesQuotaSummaryStrategyByKey}
          quotaSnapshotsByKey={quotaSnapshotsByKey}
          quotasEnabled={quotasEnabled}
          groups={authoritativeGroups}
          accountFallbackEnabled={accountFallbackEnabled}
          groupConfigurationSupported={runtimeGroupCapability.groupConfigurationSupported}
          runtimeGroupFallbackSupported={runtimeGroupFallbackSupported}
          onCreateGroup={() => void handleCreateGroup()}
          onOpenGroup={(groupId) => handleOpenGroup(groupId)}
          onSetGroupAutoSwitch={(groupId, autoSwitch) => void handleSetGroupAutoSwitch(groupId, autoSwitch)}
          onSetGroupStrategy={(groupId, strategy) => void handleSetGroupStrategy(groupId, strategy)}
          onDeleteGroup={(groupId, label) => void handleDeleteGroup(groupId, label)}
          onAddMember={(groupId, profileId) => void handleAddMember(groupId, profileId)}
          onSetActiveMember={(groupId, profileId, expectedGeneration) => void handleSetActiveMember(groupId, profileId, expectedGeneration)}
          onSetMemberEnabled={(groupId, profileId, enabled) => void handleSetMemberEnabled(groupId, profileId, enabled)}
          onEditMemberPriority={(groupId, profileId, currentPriority) => void handleEditMemberPriority(groupId, profileId, currentPriority)}
          onRemoveMember={(groupId, profileId) => void handleRemoveMember(groupId, profileId)}
        />
      ) : null}

      {quotasEnabled ? (
        <ConnectedServiceDetailQuotasSection
          serviceId={serviceId}
          profiles={profiles}
          profileLabelsByKey={settings.connectedServicesProfileLabelByKey}
          pinnedMeterIdsByKey={settings.connectedServicesQuotaPinnedMeterIdsByKey}
          onSetPinnedMeterIds={(profileId, nextPinned) => void setPinnedQuotaMeters(profileId, nextPinned)}
          onSnapshot={(key, snapshot) => setQuotaSnapshotsByKey((prev) => ({ ...prev, [key]: snapshot }))}
        />
      ) : null}

      <ConnectedServiceDetailActionsGroup
        supportsOauth={Boolean(entry.supportsOauth)}
        oauthAddActionModes={oauthAddActionModes}
        supportsToken={Boolean(entry.supportsToken)}
        tokenKind={entry.tokenKind ?? null}
        tokenSetupUrl={entry.tokenSetupUrl ?? null}
        onAddOauthProfile={(method) => void handleAddOauthProfile(method)}
        onConnectToken={() => void handleConnectToken()}
        onOpenTokenSetupUrl={(url) => void handleOpenTokenSetupUrl(url)}
      />

    </ItemList>
  );
});
