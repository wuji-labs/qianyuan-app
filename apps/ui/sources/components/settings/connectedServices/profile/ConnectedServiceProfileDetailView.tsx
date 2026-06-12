import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
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
import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { buildConnectedServiceCredentialRecord, ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { ConnectedServiceQuotaCard } from '../ConnectedServiceQuotaCard';
import {
  isConnectedServiceCredentialReferencedByGroupError,
  resolveConnectedServiceSettingsErrorMessage,
} from '../errors/connectedServiceSettingsErrors';
import { resolveConnectedServiceDisplayName } from '../model/resolveConnectedServiceDisplayName';
import {
  formatConnectedServiceProfileGroupReferenceLabels,
  resolveConnectedServiceProfileGroupReferenceLabels,
} from '../model/resolveConnectedServiceProfileGroupReferences';
import { promptConnectedServiceTokenValue } from '../promptConnectedServiceTokenValue';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { storeConnectedServiceCredentialWithIdentityConfirmation } from '../storeConnectedServiceCredentialWithIdentityConfirmation';
import { runConnectedServiceCredentialStoredEffects } from '../runConnectedServiceCredentialStoredEffects';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const ConnectedServiceProfileDetailView = React.memo(function ConnectedServiceProfileDetailView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const profile = useProfile();
  const settings = useSettings();
  const applySettings = useApplySettings();

  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam((params as Record<string, unknown>).profileId).trim();

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

  if (!serviceId || !profileId) {
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

  const serviceLabel = resolveConnectedServiceDisplayName(serviceId, t);
  const entry = getConnectedServiceRegistryEntry(serviceId);
  const svc = profile.connectedServicesV2.find((s) => s.serviceId === serviceId) ?? null;
  const profileRecord = (svc?.profiles ?? []).find((p) => p.profileId === profileId) ?? null;

  if (!svc || !profileRecord) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.detail.alerts.unknownProfileTitle')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>
              {t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel })}
            </Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  const status = profileRecord?.status === 'connected'
    ? 'connected'
    : profileRecord?.status === 'refreshing'
      ? 'refreshing'
      : profileRecord?.status === 'refresh_failed_retryable'
        ? 'refresh_failed_retryable'
        : 'needs_reauth';
  const kind = profileRecord?.kind === 'token' ? 'token' : profileRecord?.kind === 'oauth' ? 'oauth' : null;
  const providerEmail = typeof profileRecord?.providerEmail === 'string' ? profileRecord.providerEmail : '';
  const providerAccountId = typeof profileRecord?.providerAccountId === 'string' ? profileRecord.providerAccountId : '';

  const label = resolveConnectedServiceProfileLabel({
    labelsByKey: settings.connectedServicesProfileLabelByKey,
    serviceId,
    profileId,
  });
  const title = label || profileId;

  const isDefault = (settings.connectedServicesDefaultProfileByServiceId[serviceId] ?? '') === profileId;

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const handleDisconnect = async () => {
    const groupReferenceLabels = accountGroupsEnabled
      ? resolveConnectedServiceProfileGroupReferenceLabels({
        profileId,
        projectedGroups: svc.groups,
      })
      : [];
    const cleanupGroupReferences = groupReferenceLabels.length > 0;
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      cleanupGroupReferences
        ? t('connectedServices.detail.disconnectGroupCleanupConfirmBody', {
          service: serviceLabel,
          profileId,
          groups: formatConnectedServiceProfileGroupReferenceLabels(groupReferenceLabels),
        })
        : t('connectedServices.detail.disconnectConfirmBody', { service: serviceLabel, profileId }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    const disconnect = async (cleanup: boolean) => {
      const credentials = ensureCredentials();
      await deleteConnectedServiceCredentialForAccount(credentials, {
        serviceId,
        profileId,
        ...(cleanup ? { cleanupGroupReferences: true } : {}),
      });
      await sync.refreshProfile();
      router.back();
    };
    try {
      await disconnect(cleanupGroupReferences);
    } catch (error: unknown) {
      if (!cleanupGroupReferences && isConnectedServiceCredentialReferencedByGroupError(error)) {
        const retry = await Modal.confirm(
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryTitle'),
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryBody', { service: serviceLabel, profileId }),
          {
            confirmText: t('connectedServices.detail.errors.disconnectGroupCleanupRetryConfirm'),
            cancelText: t('common.cancel'),
          },
        );
        if (retry) {
          try {
            await disconnect(true);
            return;
          } catch (retryError: unknown) {
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
            return;
          }
        }
        return;
      }
      await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
    }
  };

  const handleSetDefault = async () => {
    const nextMap = { ...settings.connectedServicesDefaultProfileByServiceId };
    if (isDefault) delete nextMap[serviceId];
    else nextMap[serviceId] = profileId;
    applySettings({ connectedServicesDefaultProfileByServiceId: nextMap });
  };

  const handleReplaceToken = async () => {
    if (kind !== 'token') return;
    const tokenValue = await promptConnectedServiceTokenValue(entry?.tokenKind ?? null);
    if (!tokenValue) return;
    const credentials = ensureCredentials();
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId,
      profileId,
      kind: 'token',
      token: {
        token: tokenValue,
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, {
      serviceId,
      profileId,
      record,
    }, { onStored: runConnectedServiceCredentialStoredEffects });
    if (!stored) return;
    await Modal.alert(
      t('connectedServices.oauthPaste.alerts.connectedTitle'),
      t('connectedServices.oauthPaste.alerts.connectedBody', { serviceId: serviceLabel, profileId }),
    );
  };

  const handleEditLabel = async () => {
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

  const pinnedKey = connectedServiceProfileKey({ serviceId, profileId });
  const pinnedMeterIds = settings.connectedServicesQuotaPinnedMeterIdsByKey[pinnedKey] ?? [];

  const setPinnedQuotaMeters = async (nextPinned: ReadonlyArray<string>) => {
    const nextMap = { ...settings.connectedServicesQuotaPinnedMeterIdsByKey };
    if (nextPinned.length === 0) delete nextMap[pinnedKey];
    else nextMap[pinnedKey] = [...nextPinned];
    applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
  };

  return (
    <ItemList>
      <ItemGroup title={`${serviceLabel} • ${title}`}>
        <Item
          title={t('connectedServices.profile.profileId')}
          subtitle={profileId}
          showChevron={false}
        />
        <Item
          title={t('connectedServices.profile.status')}
          subtitle={status === 'connected'
            ? t('connectedServices.detail.profiles.connected')
            : status === 'refreshing'
              ? t('connectedServices.detail.profiles.refreshing')
              : status === 'refresh_failed_retryable'
                ? t('connectedServices.detail.profiles.refreshFailedRetryable')
                : t('connectedServices.detail.profiles.needsReauth')}
          showChevron={false}
        />
        {providerEmail ? (
          <Item
            title={t('connectedServices.profile.email')}
            subtitle={providerEmail}
            showChevron={false}
          />
        ) : null}
        {providerAccountId ? (
          <Item
            title={t('connectedServices.profile.accountId')}
            subtitle={providerAccountId}
            showChevron={false}
          />
        ) : null}
      </ItemGroup>

      {quotasEnabled && status === 'connected' ? (
        <ConnectedServiceQuotaCard
          serviceId={serviceId}
          profileId={profileId}
          title={t('connectedServices.profile.quotaTitle')}
          pinnedMeterIds={pinnedMeterIds}
          onSetPinnedMeterIds={(next) => void setPinnedQuotaMeters(next)}
        />
      ) : null}

      <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
        <Item
          title={isDefault ? t('connectedServices.detail.actions.unsetDefault') : t('connectedServices.detail.actions.setDefault')}
          subtitle={isDefault ? t('connectedServices.profile.defaultSubtitle') : t('connectedServices.profile.setDefaultSubtitle')}
          icon={<Ionicons name={isDefault ? 'star' : 'star-outline'} size={22} color={theme.colors.accent.blue} />}
          onPress={() => void handleSetDefault()}
        />
        <Item
          title={t('connectedServices.detail.actions.editLabel')}
          subtitle={t('connectedServices.detail.setProfileLabelSubtitle')}
          icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
          onPress={() => void handleEditLabel()}
        />
        {kind === 'token' ? (
          <Item
            title={t('connectedServices.detail.actions.replaceToken')}
            subtitle={t('connectedServices.profile.replaceTokenSubtitle')}
            icon={<Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => void handleReplaceToken()}
          />
        ) : null}
        {status === 'connected' ? (
          <Item
            title={t('modals.disconnect')}
            subtitle={t('connectedServices.profile.disconnectSubtitle')}
            icon={<Ionicons name="trash-outline" size={22} color={theme.colors.state.danger.foreground} />}
            onPress={() => void handleDisconnect()}
          />
        ) : kind !== 'token' && status === 'needs_reauth' ? (
          <Item
            testID="connected-services-profile-action:reconnect"
            title={t('connectedServices.detail.actions.reconnect')}
            subtitle={t('connectedServices.profile.reconnectSubtitle')}
            icon={<Ionicons name="refresh-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => router.push({ pathname: '/settings/connected-services/oauth', params: { serviceId, profileId } })}
          />
        ) : null}
      </ItemGroup>
    </ItemList>
  );
});
