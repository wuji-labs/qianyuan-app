const path = require('node:path');

// Keep this module dependency-free so it can run in GitHub Actions before `yarn install`.
// We load the canonical release ring catalog from the checked-in CJS entrypoint.
const releaseRings = require(path.resolve(__dirname, '..', '..', 'packages', 'release-runtime', 'releaseRings.cjs'));
const { getReleaseRingCatalogEntry, normalizeReleaseRingId } = releaseRings;

function resolveLogicalVariantFromRing(ring) {
    if (ring.expoAppEnv === 'production') return 'production';
    if (ring.expoAppEnv === 'development') return 'development';
    return 'preview';
}

function buildRingBackedConfig(ringId, overrides) {
    const ring = getReleaseRingCatalogEntry(ringId);
    return {
        id: ringId,
        logicalVariant: resolveLogicalVariantFromRing(ring),
        name: overrides.name,
        iosBundleId: overrides.iosBundleId,
        androidPackage: overrides.androidPackage,
        scheme: overrides.scheme,
        updatesChannel: ring.expoUpdatesChannel,
        featurePolicyEnv: ring.embeddedPolicyEnv,
        enableAssociatedDomains: overrides.enableAssociatedDomains,
    };
}

function buildProductionConfig(overrides) {
    const ring = getReleaseRingCatalogEntry('stable');
    return {
        id: 'production',
        logicalVariant: 'production',
        name: overrides.name,
        iosBundleId: overrides.iosBundleId,
        androidPackage: overrides.androidPackage,
        scheme: overrides.scheme,
        updatesChannel: ring.expoUpdatesChannel,
        featurePolicyEnv: ring.embeddedPolicyEnv,
        enableAssociatedDomains: overrides.enableAssociatedDomains,
    };
}

// WUJI fork: 乾元無極 brand injected over happier base.
// Variant names, bundle IDs, and URL schemes follow the same 5-lane structure
// so the build/publish/release-ring machinery works unchanged.
const APP_ENVIRONMENT_CONFIGS = {
    internaldev: buildRingBackedConfig('internaldev', {
        name: '乾元無極 (内部)',
        iosBundleId: 'com.wujilabs.qianyuan.dev.internal',
        androidPackage: 'com.wujilabs.qianyuan.internaldev',
        scheme: 'qianyuan-internaldev',
        enableAssociatedDomains: false,
    }),
    internalpreview: buildRingBackedConfig('internalpreview', {
        name: '乾元無極 (内部预览)',
        iosBundleId: 'com.wujilabs.qianyuan.internalpreview',
        androidPackage: 'com.wujilabs.qianyuan.internalpreview',
        scheme: 'qianyuan-internalpreview',
        enableAssociatedDomains: false,
    }),
    publicdev: buildRingBackedConfig('publicdev', {
        name: '乾元無極 (dev)',
        iosBundleId: 'com.wujilabs.qianyuan.dev',
        androidPackage: 'com.wujilabs.qianyuan.publicdev',
        scheme: 'qianyuan-dev',
        enableAssociatedDomains: false,
    }),
    preview: buildRingBackedConfig('preview', {
        name: '乾元無極 (preview)',
        iosBundleId: 'com.wujilabs.qianyuan.preview',
        androidPackage: 'com.wujilabs.qianyuan.preview',
        scheme: 'qianyuan-preview',
        enableAssociatedDomains: false,
    }),
    production: buildProductionConfig({
        name: '乾元無極',
        iosBundleId: 'com.wujilabs.qianyuan',
        androidPackage: 'com.wujilabs.qianyuan',
        scheme: 'qianyuan',
        enableAssociatedDomains: true,
    }),
};

function normalizeAppEnvironmentId(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return '';
    if (Object.prototype.hasOwnProperty.call(APP_ENVIRONMENT_CONFIGS, value)) {
        return value;
    }

    const ring = normalizeReleaseRingId(value);
    if (!ring) return '';
    return ring === 'stable' ? 'production' : ring;
}

function getAppEnvironmentConfig(raw) {
    const normalized = normalizeAppEnvironmentId(raw) || 'internaldev';
    return APP_ENVIRONMENT_CONFIGS[normalized];
}

module.exports = {
    APP_ENVIRONMENT_CONFIGS,
    getAppEnvironmentConfig,
    normalizeAppEnvironmentId,
};
