type InFlightSteerRuntime = Readonly<{
    supportsInFlightSteer: () => boolean;
    isTurnInFlight: () => boolean;
    canSteerPrompt?: () => boolean;
}>;

export function shouldUseInFlightSteer(params: Readonly<{
    runtime: InFlightSteerRuntime | null;
    didChangePermissionMode: boolean;
    isSpecialCommand: boolean;
}>): boolean {
    const { runtime } = params;
    if (!runtime) return false;
    if (!runtime.supportsInFlightSteer()) return false;
    if (params.didChangePermissionMode) return false;
    if (params.isSpecialCommand) return false;
    return runtime.canSteerPrompt ? runtime.canSteerPrompt() : runtime.isTurnInFlight();
}
