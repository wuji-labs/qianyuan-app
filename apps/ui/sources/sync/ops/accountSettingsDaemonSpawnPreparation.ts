export type AccountSettingsDaemonSpawnPreparation = Readonly<{
    accountSettingsVersionHint?: number;
}>;

type PrepareAccountSettingsForDaemonSpawn = () => Promise<AccountSettingsDaemonSpawnPreparation>;

let prepareAccountSettingsForDaemonSpawn: PrepareAccountSettingsForDaemonSpawn | null = null;

function hasValidAccountSettingsVersionHint(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function registerAccountSettingsDaemonSpawnPreparation(
    prepare: PrepareAccountSettingsForDaemonSpawn,
): () => void {
    prepareAccountSettingsForDaemonSpawn = prepare;
    return () => {
        if (prepareAccountSettingsForDaemonSpawn === prepare) {
            prepareAccountSettingsForDaemonSpawn = null;
        }
    };
}

export async function prepareAccountSettingsForDaemonSpawnIfNeeded(
    existingVersionHint: unknown,
): Promise<AccountSettingsDaemonSpawnPreparation> {
    if (hasValidAccountSettingsVersionHint(existingVersionHint)) return {};
    if (!prepareAccountSettingsForDaemonSpawn) return {};
    return await prepareAccountSettingsForDaemonSpawn();
}
