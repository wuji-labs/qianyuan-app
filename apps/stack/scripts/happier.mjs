import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

await bundleWorkspaceDeps();
await import('./happier_main.mjs');
