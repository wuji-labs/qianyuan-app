import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { t } from '@/text';

export function HiddenInactiveSessionsEmptyState(): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();

    return (
        <ItemList testID="sessions-hidden-inactive-empty-state-list" containerStyle={{ paddingTop: 12 }}>
            <CenteredInfoTile
                titleTestID="sessions-hidden-inactive-empty-state-title"
                descriptionTestID="sessions-hidden-inactive-empty-state-description"
                title={t('settingsFeatures.hiddenInactiveSessionsEmptyStateTitle')}
                description={t('settingsFeatures.hiddenInactiveSessionsEmptyStateSubtitle')}
                icon={(
                    <Ionicons
                        testID="session-empty-state-icon"
                        name="chatbubbles-outline"
                        size={48}
                        color={theme.colors.textSecondary}
                        style={{ marginBottom: 12 }}
                    />
                )}
            />

            <ItemGroup>
                <Item
                    testID="sessions-hidden-inactive-empty-state-open-archived"
                    title={t('sessionInfo.inactiveAndArchivedSessions')}
                    icon={<Ionicons name="archive-outline" size={22} color={theme.colors.textSecondary} />}
                    onPress={() => router.push('/session/archived' as any)}
                />
            </ItemGroup>
        </ItemList>
    );
}
