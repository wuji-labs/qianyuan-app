import { describe, expect, it } from 'vitest';

import {
    SessionGoalSetRequestV1Schema,
    SessionVendorPluginCatalogListResponseV1Schema,
    SessionWorkStateGetResponseV1Schema,
} from './sessionWorkStateRpc.js';
import { SESSION_RPC_METHODS } from '../rpc.js';

describe('session work-state RPC contracts', () => {
    it('defines session-scoped RPC method ids', () => {
        expect(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET).toBe('session.workState.get');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_GET).toBe('session.goal.get');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_SET).toBe('session.goal.set');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR).toBe('session.goal.clear');
        expect(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST).toBe('session.vendorPluginCatalog.list');
        expect(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST).toBe('session.skillCatalog.list');
    });

    it('parses work-state and vendor plugin catalog response shapes', () => {
        expect(SessionWorkStateGetResponseV1Schema.parse({ workState: null })).toEqual({ workState: null });
        expect(SessionGoalSetRequestV1Schema.parse({ objective: 'Ship goals', status: 'active', tokenBudget: null })).toEqual({
            objective: 'Ship goals',
            status: 'active',
            tokenBudget: null,
        });
        expect(SessionGoalSetRequestV1Schema.parse({ status: 'paused' })).toEqual({
            status: 'paused',
        });
        expect(() => SessionGoalSetRequestV1Schema.parse({})).toThrow();
        expect(SessionVendorPluginCatalogListResponseV1Schema.parse({
            vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail', enabled: true }],
        }).vendorPlugins[0]?.vendorPluginRef).toBe('plugin://gmail@openai-curated');
    });
});
