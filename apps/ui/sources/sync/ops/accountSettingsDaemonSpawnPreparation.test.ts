import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    prepareAccountSettingsForDaemonSpawnIfNeeded,
    registerAccountSettingsDaemonSpawnPreparation,
} from './accountSettingsDaemonSpawnPreparation';

describe('account settings daemon spawn preparation registry', () => {
    beforeEach(() => {
        registerAccountSettingsDaemonSpawnPreparation(async () => ({}))();
    });

    it('returns no hint when no preparation provider is registered', async () => {
        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).resolves.toEqual({});
    });

    it('uses the registered preparation provider when no valid hint exists', async () => {
        const prepare = vi.fn(async () => ({ accountSettingsVersionHint: 7 }));
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).resolves.toEqual({
            accountSettingsVersionHint: 7,
        });
        expect(prepare).toHaveBeenCalledTimes(1);

        unregister();
    });

    it('does not override an explicit valid version hint', async () => {
        const prepare = vi.fn(async () => ({ accountSettingsVersionHint: 7 }));
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(4)).resolves.toEqual({});
        expect(prepare).not.toHaveBeenCalled();

        unregister();
    });

    it('keeps the latest registered provider until it is unregistered', async () => {
        const first = vi.fn(async () => ({ accountSettingsVersionHint: 1 }));
        const second = vi.fn(async () => ({ accountSettingsVersionHint: 2 }));
        const unregisterFirst = registerAccountSettingsDaemonSpawnPreparation(first);
        const unregisterSecond = registerAccountSettingsDaemonSpawnPreparation(second);

        unregisterFirst();

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(null)).resolves.toEqual({
            accountSettingsVersionHint: 2,
        });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);

        unregisterSecond();
    });
});
