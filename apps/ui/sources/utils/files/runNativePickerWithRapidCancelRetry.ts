import { Keyboard } from 'react-native';

function readPositiveIntFromEnv(key: string, fallback: number, opts?: Readonly<{ min?: number; max?: number }>): number {
    const raw = String(process.env[key] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    const min = opts?.min ?? 0;
    const max = opts?.max ?? 30_000;
    return Math.max(min, Math.min(max, parsed));
}

function readRapidCancelThresholdMs(): number {
    return readPositiveIntFromEnv('EXPO_PUBLIC_HAPPIER_NATIVE_PICKER_RAPID_CANCEL_MS', 120, { min: 0, max: 5_000 });
}

function readRetryDelayMs(): number {
    return readPositiveIntFromEnv('EXPO_PUBLIC_HAPPIER_NATIVE_PICKER_RETRY_DELAY_MS', 150, { min: 0, max: 5_000 });
}

async function sleepMs(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Expo pickers can occasionally "cancel" immediately without ever showing UI (most commonly when
 * iOS is in the middle of another presentation/dismissal or a keyboard animation). In that case
 * we retry once after a short delay, and if it still cancels immediately we throw so callers can
 * surface a user-visible error instead of silently doing nothing.
 */
export async function runNativePickerWithRapidCancelRetry<T extends Readonly<{ canceled?: boolean }>>(
    open: () => Promise<T>,
    params: Readonly<{ pickerLabelForError: string }>,
): Promise<T> {
    const rapidCancelMs = readRapidCancelThresholdMs();
    const retryDelayMs = readRetryDelayMs();

    let lastElapsedMs: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        // Best-effort: presenting system UI while a TextInput is focused can be flaky on iOS.
        try {
            Keyboard.dismiss();
        } catch {
            // ignore
        }

        const startedAt = Date.now();
        const result = await open();
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        lastElapsedMs = elapsedMs;

        const canceled = Boolean((result as any)?.canceled);
        const rapidCanceled = canceled && elapsedMs <= rapidCancelMs;
        if (!rapidCanceled) return result;

        if (attempt === 0) {
            await sleepMs(retryDelayMs);
            continue;
        }

        break;
    }

    throw new Error(
        `${params.pickerLabelForError} was dismissed immediately. `
        + `This usually means iOS/Android could not present the system picker UI (for example: another modal/menu is dismissing or the keyboard is mid-animation). `
        + `Try dismissing the keyboard, closing menus, then try again.`
        + (typeof lastElapsedMs === 'number' ? ` (elapsed: ${lastElapsedMs}ms)` : ''),
    );
}
