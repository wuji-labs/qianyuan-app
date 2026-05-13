export type CodexAppServerRpcError = Error & Readonly<{
    code?: number;
    data?: unknown;
    method?: string;
}>;

export function createCodexAppServerRpcError(params: Readonly<{
    method: string;
    code?: number;
    message?: string;
    data?: unknown;
}>): CodexAppServerRpcError {
    const error = new Error(params.message ?? `Codex app-server request failed: ${params.method}`) as CodexAppServerRpcError;
    if (typeof params.code === 'number') {
        Object.defineProperty(error, 'code', { value: params.code, enumerable: true });
    }
    Object.defineProperty(error, 'method', { value: params.method, enumerable: true });
    if (params.data !== undefined) {
        Object.defineProperty(error, 'data', { value: params.data, enumerable: true });
    }
    return error;
}

function readCode(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

function readMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

export function isCodexAppServerMethodNotFoundError(error: unknown): boolean {
    if (readCode(error) === -32601) return true;
    return /method\s+not\s+found/i.test(readMessage(error));
}

export function isCodexAppServerInvalidParamsError(error: unknown): boolean {
    if (readCode(error) === -32602) return true;
    return /invalid\s+params/i.test(readMessage(error));
}

export function isCodexAppServerExperimentalApiUnavailableError(error: unknown): boolean {
    const message = readMessage(error);
    if (!/experimental/i.test(message)) return false;
    return isCodexAppServerMethodNotFoundError(error) || isCodexAppServerInvalidParamsError(error);
}

export function shouldRetryCodexAppServerRequestWithoutExperimentalParams(error: unknown): boolean {
    return isCodexAppServerMethodNotFoundError(error)
        || isCodexAppServerInvalidParamsError(error)
        || isCodexAppServerExperimentalApiUnavailableError(error);
}
