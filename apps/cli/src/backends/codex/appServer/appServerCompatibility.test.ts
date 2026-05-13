import { describe, expect, it } from 'vitest';

import {
    isCodexAppServerExperimentalApiUnavailableError,
    isCodexAppServerInvalidParamsError,
    isCodexAppServerMethodNotFoundError,
} from './appServerCompatibility';

function makeError(message: string, code?: number): Error {
    const error = new Error(message) as Error & { code?: number };
    if (typeof code === 'number') {
        error.code = code;
    }
    return error;
}

describe('appServerCompatibility', () => {
    it('detects JSON-RPC method-not-found errors by code and message fallback', () => {
        expect(isCodexAppServerMethodNotFoundError(makeError('nope', -32601))).toBe(true);
        expect(isCodexAppServerMethodNotFoundError(makeError('Method not found'))).toBe(true);
        expect(isCodexAppServerMethodNotFoundError(makeError('Invalid params', -32602))).toBe(false);
    });

    it('detects JSON-RPC invalid-params errors by code and message fallback', () => {
        expect(isCodexAppServerInvalidParamsError(makeError('nope', -32602))).toBe(true);
        expect(isCodexAppServerInvalidParamsError(makeError('Invalid params: unknown field permissions'))).toBe(true);
        expect(isCodexAppServerInvalidParamsError(makeError('Method not found', -32601))).toBe(false);
    });

    it('detects experimental API gating errors without treating all invalid params as gated', () => {
        expect(isCodexAppServerExperimentalApiUnavailableError(makeError('experimental API is not enabled', -32602))).toBe(true);
        expect(isCodexAppServerExperimentalApiUnavailableError(makeError('unknown experimental method', -32601))).toBe(true);
        expect(isCodexAppServerExperimentalApiUnavailableError(makeError('Invalid params: missing field'))).toBe(false);
    });
});
