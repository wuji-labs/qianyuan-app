import React from 'react';
import { Pressable, View, SectionList, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { Typography } from '@/constants/Typography';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useAllSessions, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { sessionUnarchiveWithServerScope } from '@/sync/ops';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    list: {
        flex: 1,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    sectionDescription: {
        marginTop: 6,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sessionCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: 16,
        marginBottom: 1,
        paddingVertical: 16,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionCardFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionCardLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionCardSingle: {
        borderRadius: 12,
        marginBottom: 12,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    actionButton: {
        width: 34,
        height: 34,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

function canManageArchive(session: Session): boolean {
    // Owner sessions have no accessLevel set; shared sessions require admin.
    return !session.accessLevel || session.accessLevel === 'admin';
}

function normalizePinnedSessionKey(serverIdRaw: unknown, sessionIdRaw: unknown): string | null {
    const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

export default function ArchivedSessionsScreen() {
    const safeArea = useSafeAreaInsets();
    const navigateToSession = useNavigateToSession();
    const allSessions = useAllSessions();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const pinnedSessionKeysV1 = useSetting('pinnedSessionKeysV1') ?? [];

    const pinnedSessionKeySet = React.useMemo(() => {
        return new Set(
            pinnedSessionKeysV1
                .map((key) => (typeof key === 'string' ? key.trim() : ''))
                .filter(Boolean),
        );
    }, [pinnedSessionKeysV1]);

    const archivedSessions = React.useMemo(() => {
        return allSessions
            .filter((s) => s.archivedAt != null)
            .slice()
            .sort((a, b) => {
                const aAt = typeof a.archivedAt === 'number' ? a.archivedAt : 0;
                const bAt = typeof b.archivedAt === 'number' ? b.archivedAt : 0;
                if (bAt !== aAt) return bAt - aAt;
                return b.updatedAt - a.updatedAt;
            });
    }, [allSessions]);

    const hiddenInactiveSessions = React.useMemo(() => {
        if (!hideInactiveSessions) return [];

        return allSessions
            .filter((session) => {
                if (session.archivedAt != null) return false;
                if (session.active === true) return false;
                const sessionKey = normalizePinnedSessionKey((session as any).serverId, session.id);
                if (sessionKey && pinnedSessionKeySet.has(sessionKey)) return false;
                return true;
            })
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }, [allSessions, hideInactiveSessions, pinnedSessionKeySet]);

    const sections = React.useMemo(() => {
        const nextSections: Array<{
            key: 'archived' | 'hidden_inactive';
            title: string;
            data: Session[];
        }> = [];

        if (hiddenInactiveSessions.length > 0) {
            nextSections.push({
                key: 'hidden_inactive',
                title: t('settingsFeatures.hiddenInactiveSessionsSectionTitle'),
                data: hiddenInactiveSessions,
            });
        }

        if (archivedSessions.length > 0) {
            nextSections.push({
                key: 'archived',
                title: t('sessionInfo.archivedSessions'),
                data: archivedSessions,
            });
        }

        return nextSections;
    }, [archivedSessions, hiddenInactiveSessions]);

    const handleUnarchive = React.useCallback((session: Session) => {
        Modal.alert(
            t('sessionInfo.unarchiveSession'),
            t('sessionInfo.unarchiveSessionConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.unarchiveSession'),
                    style: 'default',
                    onPress: async () => {
                        const result = await sessionUnarchiveWithServerScope(session.id, { serverId: null });
                        if (!result.success) {
                            Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToUnarchiveSession'));
                        }
                    },
                },
            ],
        );
    }, []);

    const renderItem = React.useCallback(
        ({ item, index, section }: { item: Session; index: number; section: { key: 'archived' | 'hidden_inactive'; data: Session[] } }) => {
            const sessionName = getSessionName(item);
            const sessionSubtitle = getSessionSubtitle(item);
            const avatarId = getSessionAvatarId(item);

            const isFirst = index === 0;
            const isLast = index === section.data.length - 1;
            const isSingle = section.data.length === 1;
            const canShowUnarchive = section.key === 'archived' && canManageArchive(item);

            return (
                <Pressable
                    style={[
                        styles.sessionCard,
                        isSingle ? styles.sessionCardSingle : isFirst ? styles.sessionCardFirst : isLast ? styles.sessionCardLast : null,
                    ]}
                    onPress={() => navigateToSession(item.id)}
                >
                    <Avatar id={avatarId} size={48} />
                    <View style={styles.sessionContent}>
                        <Text style={styles.sessionTitle} numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {sessionSubtitle}
                        </Text>
                    </View>
                    {canShowUnarchive ? (
                        <Pressable
                            style={styles.actionButton}
                            onPress={() => handleUnarchive(item)}
                            accessibilityRole="button"
                            accessibilityLabel={t('sessionInfo.unarchiveSession')}
                            hitSlop={8}
                        >
                            <Ionicons name="arrow-undo-outline" size={18} color={String((styles.sessionSubtitle as any)?.color ?? '#666')} />
                        </Pressable>
                    ) : null}
                </Pressable>
            );
        },
        [handleUnarchive, navigateToSession],
    );

    const renderSectionHeader = React.useCallback(
        ({ section }: { section: { title: string } }) => (
            <View style={styles.headerSection}>
                <Text style={styles.headerText}>{section.title}</Text>
            </View>
        ),
        [],
    );

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                {sections.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>{t('sessionHistory.empty')}</Text>
                    </View>
                ) : (
                    <SectionList
                        style={styles.list}
                        sections={sections}
                        renderItem={renderItem}
                        renderSectionHeader={renderSectionHeader}
                        keyExtractor={(item) => item.id}
                        {...(Platform.OS === 'web'
                            ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                            : null)}
                        contentContainerStyle={{ paddingBottom: safeArea.bottom + 64, maxWidth: layout.maxWidth }}
                    />
                )}
            </View>
        </View>
    );
}
