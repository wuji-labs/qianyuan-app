import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsSpy = vi.fn(async () => {});
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  alert: vi.fn(),
}));
const textSpies = vi.hoisted(() => ({
  translate: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}));
const routeParams = { serviceId: 'openai-codex', profileId: 'work' };
const profileState = {
  connectedServicesV2: [
    {
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
    },
  ],
};
const settingsState = vi.hoisted(() => ({
  current: {
    connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
    connectedServicesProfileLabelByKey: {} as Record<string, string>,
    connectedServicesQuotaPinnedMeterIdsByKey: {},
    connectedServicesQuotaSummaryStrategyByKey: {},
  },
}));

async function flushAsyncHandlers() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

installConnectedServicesCommonModuleMocks({
  searchParams: routeParams,
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        confirm: modalSpies.confirm,
        prompt: modalSpies.prompt,
        alert: modalSpies.alert,
      },
    }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: textSpies.translate });
  },
});

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureId === 'connectedServices.quotas' || featureId === 'connectedServices',
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => profileState,
    useSettings: () => settingsState.current,
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee', updatedAt: 0 })),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
  requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
  requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceProfileDetailView', () => {
  beforeEach(() => {
    routeParams.serviceId = 'openai-codex';
    routeParams.profileId = 'work';
    applySettingsSpy.mockClear();
    modalSpies.confirm.mockReset();
    modalSpies.prompt.mockReset();
    modalSpies.alert.mockReset();
    textSpies.translate.mockClear();
    settingsState.current = {
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    };
  });

    it('passes the resolved profile label to destructive disconnect confirmation text', async () => {
        settingsState.current = {
            ...settingsState.current,
            connectedServicesProfileLabelByKey: { 'openai-codex/work': 'Work laptop' },
        };
        modalSpies.confirm.mockResolvedValueOnce(false);
        const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');

        const screen = await renderScreen(<ConnectedServiceProfileDetailView />);
        const disconnectRow = screen.tree.root.find((node) =>
            node.props?.title === 'modals.disconnect'
            && typeof node.props?.onPress === 'function');

        await act(async () => {
            disconnectRow.props.onPress();
            await flushAsyncHandlers();
        });

        const disconnectBodyCall = textSpies.translate.mock.calls.find(([key]) =>
            key === 'connectedServices.detail.disconnectConfirmBody');
        const params = disconnectBodyCall?.[1] as { profileId?: unknown } | undefined;
        const profileLabel = String(params?.profileId ?? '');
        expect(profileLabel).toContain('Work laptop');
        expect(profileLabel).toContain('work');
        expect(profileLabel).not.toBe('work');
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'modals.disconnect',
            'connectedServices.detail.disconnectConfirmBody',
            expect.objectContaining({
                confirmText: 'modals.disconnect',
                cancelText: 'common.cancel',
            }),
        );
    });

    it('renders profile details and quota card when quotas are enabled', async () => {
        const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
        const { t } = await import('@/text');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;

        expect(
            tree.findAll((n) =>
                n.props?.title === t('connectedServices.profile.email') &&
                n.props?.subtitle === 'me@example.com',
            ),
        ).toHaveLength(1);
        expect(
            tree.findAll((n) =>
                n.props?.title === t('connectedServices.profile.quotaTitle') ||
                n.props?.title === 'Refresh',
            ),
        ).not.toHaveLength(0);
    });

    it('renders an unknown-profile guard state for nonexistent profile ids', async () => {
        routeParams.profileId = 'missing';
        const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
        const { t } = await import('@/text');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;

    expect(tree.findAll((n) => n.props?.title === t('connectedServices.detail.alerts.unknownProfileTitle'))).toHaveLength(1);
    expect(tree.findAll((n) => n.props?.title === t('connectedServices.detail.actionsGroupTitle'))).toHaveLength(0);
    expect(applySettingsSpy).not.toHaveBeenCalled();
  });
});
