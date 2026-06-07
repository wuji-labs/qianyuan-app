import { requireNativeModule } from 'expo-modules-core';
import { parseSerializedJsonValue } from '@happier-dev/protocol';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type CryptoWorkerBatchRequest,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerProbeFailureReason,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';
import { recordNativeCryptoWorkerResultDecode } from './nativeCryptoWorkerTelemetry';

type NativeCapabilitiesResult = Readonly<{
    moduleVersion?: unknown;
    platform?: unknown;
    supportedOperations?: unknown;
}>;

type HappierCryptoWorkerNativeModule = Readonly<{
    getCapabilities?: () => Promise<NativeCapabilitiesResult>;
    echoBatchForDiagnostics?: (values: readonly string[]) => Promise<readonly string[]>;
    decryptDataKeyEnvelopeV1Batch?: (
        items: readonly NativeCryptoWorkerDataKeyEnvelopeItem[],
    ) => Promise<readonly (string | null)[]>;
    decryptSecretboxJsonBatch?: (
        items: readonly NativeCryptoWorkerSecretboxJsonItem[],
    ) => Promise<readonly (unknown | null)[]>;
    decryptAesGcmJsonBatch?: (
        items: readonly NativeCryptoWorkerAesGcmJsonItem[],
    ) => Promise<readonly (unknown | null)[]>;
}>;

const probeEchoPayload = 'happier-crypto-worker-probe';

let nativeModule: HappierCryptoWorkerNativeModule | null | undefined;

function getNativeModule(): HappierCryptoWorkerNativeModule | null {
    if (nativeModule !== undefined) return nativeModule;
    try {
        nativeModule = requireNativeModule<HappierCryptoWorkerNativeModule>('HappierCryptoWorker');
    } catch {
        nativeModule = null;
    }
    return nativeModule;
}

function unavailable(reason: NativeCryptoWorkerProbeFailureReason): NativeCryptoWorkerCapability {
    return {
        available: false,
        failureReason: reason,
    };
}

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function normalizeNativeVersion(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const nativeVersion = Math.trunc(value);
    return nativeVersion > 0 ? nativeVersion : null;
}

function normalizeWarmupMs(startedAtMs: number): number {
    return Math.max(0, Math.trunc(nowMs() - startedAtMs));
}

function normalizeSupportedOperations(value: unknown): NativeCryptoWorkerOperation[] {
    if (!Array.isArray(value)) return [];
    const supported = new Set(Object.values(NATIVE_CRYPTO_WORKER_OPERATION));
    return value.filter((operation): operation is NativeCryptoWorkerOperation =>
        typeof operation === 'string' && supported.has(operation as NativeCryptoWorkerOperation)
    );
}

type SerializedJsonEnvelope =
    | Readonly<{
        __happierSerializedJsonValueV1: true;
        type: 'json';
        value: unknown;
    }>
    | Readonly<{
        __happierSerializedJsonValueV1: true;
        type: 'undefined';
    }>;

function isSerializedJsonEnvelope(value: unknown): value is SerializedJsonEnvelope {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.__happierSerializedJsonValueV1 !== true) return false;
    if (candidate.type === 'undefined') return true;
    return candidate.type === 'json' && Object.prototype.hasOwnProperty.call(candidate, 'value');
}

function parseNativeSerializedJsonItem(value: unknown | null): unknown | null {
    if (value === null) return null;
    if (isSerializedJsonEnvelope(value)) {
        return value.type === 'undefined' ? undefined : value.value;
    }
    if (typeof value !== 'string') return value;
    try {
        return parseSerializedJsonValue(value);
    } catch {
        return null;
    }
}

function parseNativeSerializedJsonItems(
    operation: NativeCryptoWorkerOperation,
    values: readonly (unknown | null)[],
): Array<unknown | null> {
    const shouldRecord = syncPerformanceTelemetry.isEnabled();
    const startedAtMs = shouldRecord ? nowMs() : 0;
    let stringItems = 0;
    let objectItems = 0;
    let nullItems = 0;
    const items = values.map((value) => {
        if (value === null) {
            nullItems += 1;
        } else if (typeof value === 'string') {
            stringItems += 1;
        } else if (typeof value === 'object') {
            objectItems += 1;
        }
        return parseNativeSerializedJsonItem(value);
    });
    if (shouldRecord) {
        recordNativeCryptoWorkerResultDecode(syncPerformanceTelemetry, Math.max(0, nowMs() - startedAtMs), {
            operation,
            items: values.length,
            stringItems,
            objectItems,
            nullItems,
        });
    }
    return items;
}

async function probeNativeModule(module: HappierCryptoWorkerNativeModule): Promise<NativeCryptoWorkerCapability> {
    if (!module.getCapabilities || !module.echoBatchForDiagnostics) {
        return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
    }

    const startedAtMs = nowMs();
    const capabilities = await module.getCapabilities();
    const nativeVersion = normalizeNativeVersion(capabilities.moduleVersion);
    if (nativeVersion === null) {
        return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.wrongVersion);
    }

    const echo = await module.echoBatchForDiagnostics([probeEchoPayload]);
    if (echo.length !== 1 || echo[0] !== probeEchoPayload) {
        return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed);
    }

    return {
        available: true,
        failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
        nativeVersion,
        warmupMs: normalizeWarmupMs(startedAtMs),
        supportedOperations: normalizeSupportedOperations(capabilities.supportedOperations),
    };
}

function unavailableResult<T>(request: CryptoWorkerBatchRequest<unknown>): NativeCryptoWorkerBatchResult<T> {
    if (request.signal?.aborted === true) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
}

export function createNativeCryptoWorker(): NativeCryptoWorker {
    return {
        async probe() {
            const module = getNativeModule();
            if (!module) {
                return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
            }
            try {
                return await probeNativeModule(module);
            } catch {
                return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown);
            }
        },
        async decryptDataKeyEnvelopeV1(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>,
        ): Promise<NativeCryptoWorkerBatchResult<string | null>> {
            if (request.signal?.aborted === true) {
                return { status: 'cancelled', source: 'cancelled', items: [] };
            }
            const module = getNativeModule();
            if (!module?.decryptDataKeyEnvelopeV1Batch) {
                return unavailableResult(request);
            }
            return {
                status: 'ok',
                source: 'native',
                items: await module.decryptDataKeyEnvelopeV1Batch(request.items),
            };
        },
        async decryptSecretboxJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerSecretboxJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            if (request.signal?.aborted === true) {
                return { status: 'cancelled', source: 'cancelled', items: [] };
            }
            const module = getNativeModule();
            if (!module?.decryptSecretboxJsonBatch) {
                return unavailableResult(request);
            }
            const items = await module.decryptSecretboxJsonBatch(request.items);
            return {
                status: 'ok',
                source: 'native',
                items: parseNativeSerializedJsonItems(NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson, items),
            };
        },
        async decryptAesGcmJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerAesGcmJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            if (request.signal?.aborted === true) {
                return { status: 'cancelled', source: 'cancelled', items: [] };
            }
            const module = getNativeModule();
            if (!module?.decryptAesGcmJsonBatch) {
                return unavailableResult(request);
            }
            const items = await module.decryptAesGcmJsonBatch(request.items);
            return {
                status: 'ok',
                source: 'native',
                items: parseNativeSerializedJsonItems(NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson, items),
            };
        },
    };
}
