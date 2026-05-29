import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'agentBrowserUiPerfAudit.mjs');

async function loadModule() {
  try {
    return await import(`file://${scriptPath}`);
  } catch (error) {
    assert.fail(`agent browser UI perf audit module should load: ${error?.message ?? error}`);
  }
}

test('default plan covers the critical UI journeys and stress scenario', async () => {
  const { buildDefaultPerfAuditPlan } = await loadModule();

  const plan = buildDefaultPerfAuditPlan({ defaultDurationMs: 1234 });
  const scenarioIds = plan.scenarios.map((scenario) => scenario.id);

  assert.equal(plan.version, 1);
  assert.ok(scenarioIds.includes('desktop.sessionList.idle'));
  assert.ok(scenarioIds.includes('desktop.sessionList.scroll'));
  assert.ok(scenarioIds.includes('desktop.sessionList.search'));
  assert.ok(scenarioIds.includes('desktop.newSession.open'));
  assert.ok(scenarioIds.includes('desktop.newSession.composerTyping'));
  assert.ok(scenarioIds.includes('desktop.sessionView.idle'));
  assert.ok(scenarioIds.includes('desktop.sessionView.streamingIdle'));
  assert.ok(scenarioIds.includes('desktop.sessionView.transcriptScroll'));
  assert.ok(scenarioIds.includes('desktop.sessionView.tabs'));
  assert.ok(scenarioIds.includes('desktop.multiSessionStreaming.sidebarVisible'));
  assert.ok(scenarioIds.includes('mobile.sessionList.hiddenMounted'));
  assert.equal(plan.scenarios.every((scenario) => scenario.durationMs === 1234), true);
});

test('stress prompt wrapper confines destructive tool testing to a scratch directory', async () => {
  const { buildSafeStressPrompt } = await loadModule();

  const prompt = buildSafeStressPrompt({
    scratchDir: '/tmp/happier-ui-perf-stress-safe',
    basePrompt: 'please use write, edit, patch, remove, and bash tools',
  });

  assert.match(prompt, /\/tmp\/happier-ui-perf-stress-safe/);
  assert.match(prompt, /only inside/i);
  assert.match(prompt, /Do not modify/i);
  assert.match(prompt, /remove/);
});

test('sync tuning override enables telemetry without changing optimized production defaults', async () => {
  const { buildSyncTuningOverride } = await loadModule();

  assert.deepEqual(buildSyncTuningOverride(), {
    syncPerformanceTelemetryEnabled: true,
    syncPerformanceTelemetrySlowThresholdMs: 16,
    syncPerformanceTelemetryFlushIntervalMs: 30000,
    jsThreadLagTelemetrySampleIntervalMs: 50,
    jsThreadLagTelemetryThresholdMs: 50,
    jsThreadLagTelemetryMaxSamples: 2048,
    transcriptViewportTelemetryEnabled: true,
    transcriptViewportTelemetryMaxEvents: 2048,
  });
});

test('scenario execution phases install probes after navigation setup', async () => {
  const { resolveScenarioExecutionPhases } = await loadModule();

  assert.deepEqual(resolveScenarioExecutionPhases('sessionListScroll'), { prepare: 'root', measure: 'scroll' });
  assert.deepEqual(resolveScenarioExecutionPhases('sessionViewIdle'), { prepare: 'targetSession', measure: 'idle' });
  assert.deepEqual(resolveScenarioExecutionPhases('mobileHiddenSessionList'), { prepare: 'mobileTargetSession', measure: 'idle' });
});

test('browser probe summary reports long tasks and frame gaps', async () => {
  const { summarizeBrowserProbe } = await loadModule();

  const summary = summarizeBrowserProbe({
    startedAtMs: 0,
    finishedAtMs: 1000,
    longTasks: [
      { duration: 55 },
      { duration: 12 },
      { duration: 130 },
    ],
    frameGaps: [16, 17, 35, 80],
  });

  assert.deepEqual(summary, {
    durationMs: 1000,
    longTaskCount: 2,
    longTaskTotalMs: 185,
    maxLongTaskMs: 130,
    frameGapCount: 2,
    maxFrameGapMs: 80,
  });
});

test('detects active browser capture conflicts for safe recovery', async () => {
  const { isAgentBrowserCaptureAlreadyActiveError } = await loadModule();

  assert.equal(isAgentBrowserCaptureAlreadyActiveError('Profiling/tracing already active'), true);
  assert.equal(isAgentBrowserCaptureAlreadyActiveError('some other agent-browser failure'), false);
});

test('trace summary groups renderer, compositor, and GPU thread work', async () => {
  const { summarizeChromeTrace } = await loadModule();

  const summary = summarizeChromeTrace({
    traceEvents: [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 11, args: { name: 'CrRendererMain' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 12, args: { name: 'Compositor' } },
      { ph: 'M', name: 'thread_name', pid: 2, tid: 21, args: { name: 'VizCompositorThread' } },
      { ph: 'X', name: 'v8.callFunction', pid: 1, tid: 11, dur: 2000 },
      { ph: 'X', name: 'Layout', pid: 1, tid: 11, dur: 1000 },
      { ph: 'X', name: 'Graphics.Pipeline', pid: 1, tid: 12, dur: 3000 },
      { ph: 'X', name: 'SwapBuffers', pid: 2, tid: 21, dur: 4000 },
    ],
  });

  assert.equal(summary.totalCompleteEventMs, 10);
  assert.deepEqual(summary.threadGroups, {
    rendererMain: 3,
    compositor: 3,
    gpuViz: 4,
    other: 0,
  });
  assert.deepEqual(summary.topEvents.slice(0, 2), [
    { name: 'SwapBuffers', totalMs: 4, count: 1, maxMs: 4 },
    { name: 'Graphics.Pipeline', totalMs: 3, count: 1, maxMs: 3 },
  ]);
});
