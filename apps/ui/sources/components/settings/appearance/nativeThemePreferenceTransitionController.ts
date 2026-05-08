export interface NativeThemePreferenceTransitionControllerDependencies {
    captureSurface: () => Promise<string | null>;
    showOverlay: (uri: string) => void;
    waitForFrame: () => Promise<void>;
    animateOverlay: () => Promise<void>;
    hideOverlay: () => void;
}

export function createNativeThemePreferenceTransitionController(
    dependencies: NativeThemePreferenceTransitionControllerDependencies,
) {
    return {
        async run(mutation: () => void): Promise<void> {
            const uri = await dependencies.captureSurface();
            if (!uri) {
                mutation();
                return;
            }

            dependencies.showOverlay(uri);
            mutation();
            await dependencies.waitForFrame();
            await dependencies.animateOverlay();
            dependencies.hideOverlay();
        },
    };
}
