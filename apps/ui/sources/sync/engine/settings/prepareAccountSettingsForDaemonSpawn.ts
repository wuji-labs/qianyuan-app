import {
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import type { Settings } from '@/sync/domains/settings/settings';

export type PreparedAccountSettingsForDaemonSpawn = Readonly<{
    accountSettingsVersionHint?: number;
}>;

export type PrepareAccountSettingsForDaemonSpawnParams = Readonly<{
    settingsScope: AccountSettingsScope | null;
    pendingSettings: Partial<Settings>;
    getActiveSettingsScope: () => AccountSettingsScope | null;
    getCurrentSettingsVersion: () => number | null;
    flushPendingServerSettings: () => Promise<void>;
    clearPendingSettings: () => void;
}>;

function toVersionHint(version: number | null): PreparedAccountSettingsForDaemonSpawn {
    return typeof version === 'number' && Number.isInteger(version) && version >= 0
        ? { accountSettingsVersionHint: version }
        : {};
}

export async function prepareAccountSettingsForDaemonSpawn(
    params: PrepareAccountSettingsForDaemonSpawnParams,
): Promise<PreparedAccountSettingsForDaemonSpawn> {
    const pendingServerSettings = stripLocalOnlyAccountSettings(params.pendingSettings);
    if (Object.keys(pendingServerSettings).length === 0) {
        if (Object.keys(params.pendingSettings).length > 0) {
            params.clearPendingSettings();
        }
        return toVersionHint(params.getCurrentSettingsVersion());
    }

    const capturedScope = params.settingsScope;
    await params.flushPendingServerSettings();

    if (!areAccountSettingsScopesEqual(params.getActiveSettingsScope(), capturedScope)) {
        throw new Error('Account settings scope changed while preparing session spawn');
    }

    return toVersionHint(params.getCurrentSettingsVersion());
}
