#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_APP_URL = 'http://happier-repo-remote-dev-d72117acdb.localhost:18829/?happier_hmr=0';
const DEFAULT_DEV_KEY = 'TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q';
const DEFAULT_AGENT_BROWSER_SESSION = 'happier-ui-perf';
const SYNC_TUNING_STORAGE_KEY = 'HAPPIER_SYNC_TUNING_JSON';
const AUDIT_GLOBAL = '__HAPPIER_AGENT_BROWSER_PERF_AUDIT__';

const DEFAULT_STRESS_TEST_PROMPT = `STRESS TOOLS TESTS

please generate some very very very very long markdown content so I can test markdown streaming into our app
Please instead generate multiple markdown messages instead of one long markdown message. And in between run different
commands and tools. Can you please try to execute all of the tools that you have in your arsenal, including:
- bash
- write
- diff
- patch
- edit
- remove
- launching subagents
- doing web searches
- doing web fetches
Everything that you have in your arsenal, and trying to do a real stress test of everything, because you have been
integrated inside of our app. I actually would like to validate that everything works exactly as it should and that you
are correctly integrated and that all of the tools are correctly displayed and that the combination of all of these tools
is correctly working.
Actually trying to launch subagents, monitor the subagents, ask the subagents to also execute all of these tools. In the
meantime, execute commands, launch some new subagents, execute commands again, trying to nudge the subagents and send
them new messages. Really trying to perform a real deep stress test of all of the features that you have and all of the
features that are integrated inside of your implementation, so that we can validate that everything works exactly as it
should and everything is perfectly integrated inside our app.`;

const VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
});

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function normalizePositiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

function normalizeNonNegativeInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.trunc(number);
}

export function buildSyncTuningOverride() {
  return {
    syncPerformanceTelemetryEnabled: true,
    syncPerformanceTelemetrySlowThresholdMs: 16,
    syncPerformanceTelemetryFlushIntervalMs: 30000,
    jsThreadLagTelemetrySampleIntervalMs: 50,
    jsThreadLagTelemetryThresholdMs: 50,
    jsThreadLagTelemetryMaxSamples: 2048,
    transcriptViewportTelemetryEnabled: true,
    transcriptViewportTelemetryMaxEvents: 2048,
  };
}

export function buildSafeStressPrompt({ scratchDir, basePrompt = DEFAULT_STRESS_TEST_PROMPT }) {
  const safeScratchDir = String(scratchDir ?? '').trim() || '/tmp/happier-ui-perf-stress';
  return [
    'IMPORTANT SAFETY BOUNDARY FOR THIS UI PERFORMANCE STRESS TEST:',
    `- Use only this scratch directory for every file operation: ${safeScratchDir}`,
    '- Before any write/edit/patch/remove command, create that directory if needed and operate only inside it.',
    '- Do not modify, remove, patch, or overwrite repository files, user files, dotfiles, credentials, or files outside that scratch directory.',
    '- If a requested destructive operation would touch anything outside the scratch directory, simulate it inside the scratch directory instead and explain that you protected the real workspace.',
    '- Prefer harmless commands that produce visible tool activity and long markdown output.',
    '',
    basePrompt,
  ].join('\n');
}

export function buildDefaultPerfAuditPlan(options = {}) {
  const defaultDurationMs = normalizePositiveInt(options.defaultDurationMs, 20000);
  const scenario = (id, title, action, extra = {}) => ({
    id,
    title,
    action,
    durationMs: normalizePositiveInt(extra.durationMs, defaultDurationMs),
    viewport: extra.viewport ?? 'desktop',
    trace: extra.trace === true,
    profiler: extra.profiler === true,
    requiresTargetSession: extra.requiresTargetSession === true,
    requiresStressSessions: extra.requiresStressSessions === true,
  });

  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    scenarios: [
      scenario('desktop.sessionList.idle', 'Desktop session list idle', 'sessionListIdle', { trace: true }),
      scenario('desktop.sessionList.scroll', 'Desktop session list scroll', 'sessionListScroll', { trace: true, profiler: true }),
      scenario('desktop.sessionList.search', 'Desktop session list search/filter', 'sessionListSearch'),
      scenario('desktop.newSession.open', 'Desktop new-session screen open/idle', 'newSessionOpen', { trace: true }),
      scenario('desktop.newSession.composerTyping', 'Desktop new-session composer typing/autocomplete', 'newSessionComposerTyping', { trace: true, profiler: true }),
      scenario('desktop.sessionView.idle', 'Desktop session view idle', 'sessionViewIdle', { requiresTargetSession: true, trace: true }),
      scenario('desktop.sessionView.streamingIdle', 'Desktop session view active streaming idle', 'sessionViewStreamingIdle', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.sessionView.transcriptScroll', 'Desktop session transcript scroll', 'sessionViewTranscriptScroll', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.sessionView.tabs', 'Desktop session right-pane tab switching', 'sessionViewTabs', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.multiSessionStreaming.sidebarVisible', 'Desktop multi-session streaming with sidebar visible', 'multiSessionStreamingSidebarVisible', { requiresTargetSession: true, requiresStressSessions: true, trace: true, profiler: true }),
      scenario('mobile.sessionList.hiddenMounted', 'Mobile session list remains mounted while hidden in a session', 'mobileHiddenSessionList', { viewport: 'mobile', requiresTargetSession: true, trace: true, profiler: true }),
    ],
  };
}

export function summarizeBrowserProbe(raw) {
  const startedAtMs = Number(raw?.startedAtMs ?? 0);
  const finishedAtMs = Number(raw?.finishedAtMs ?? startedAtMs);
  const longTasks = Array.isArray(raw?.longTasks) ? raw.longTasks : [];
  const frameGaps = Array.isArray(raw?.frameGaps) ? raw.frameGaps : [];
  const blockingLongTasks = longTasks
    .map((entry) => Number(entry?.duration ?? entry ?? 0))
    .filter((duration) => Number.isFinite(duration) && duration >= 50);
  const significantFrameGaps = frameGaps
    .map((entry) => Number(entry?.gapMs ?? entry ?? 0))
    .filter((gap) => Number.isFinite(gap) && gap >= 24);
  return {
    durationMs: round(Math.max(0, finishedAtMs - startedAtMs)),
    longTaskCount: blockingLongTasks.length,
    longTaskTotalMs: round(blockingLongTasks.reduce((total, duration) => total + duration, 0)),
    maxLongTaskMs: round(blockingLongTasks.reduce((max, duration) => Math.max(max, duration), 0)),
    frameGapCount: significantFrameGaps.length,
    maxFrameGapMs: round(significantFrameGaps.reduce((max, gap) => Math.max(max, gap), 0)),
  };
}

function threadKey(event) {
  return `${event?.pid ?? ''}:${event?.tid ?? ''}`;
}

function classifyThread(name) {
  const normalized = String(name ?? '').toLowerCase();
  if (normalized.includes('crrenderermain') || normalized.includes('renderer main')) return 'rendererMain';
  if (normalized.includes('compositor') && !normalized.includes('viz')) return 'compositor';
  if (normalized.includes('viz') || normalized.includes('gpu')) return 'gpuViz';
  return 'other';
}

export function isAgentBrowserCaptureAlreadyActiveError(message) {
  return /Profiling\/tracing already active/i.test(String(message ?? ''));
}

export function summarizeChromeTrace(trace) {
  const traceEvents = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const threadNames = new Map();
  for (const event of traceEvents) {
    if (event?.ph === 'M' && event.name === 'thread_name') {
      threadNames.set(threadKey(event), event.args?.name ?? '');
    }
  }

  const threadGroups = { rendererMain: 0, compositor: 0, gpuViz: 0, other: 0 };
  const byName = new Map();
  let totalCompleteEventMs = 0;
  for (const event of traceEvents) {
    if (event?.ph !== 'X' || typeof event.dur !== 'number' || !Number.isFinite(event.dur) || event.dur <= 0) continue;
    const durationMs = event.dur / 1000;
    totalCompleteEventMs += durationMs;
    const group = classifyThread(threadNames.get(threadKey(event)));
    threadGroups[group] += durationMs;
    const name = String(event.name ?? 'unknown');
    const current = byName.get(name) ?? { name, totalMs: 0, count: 0, maxMs: 0 };
    current.totalMs += durationMs;
    current.count += 1;
    current.maxMs = Math.max(current.maxMs, durationMs);
    byName.set(name, current);
  }

  return {
    totalCompleteEventMs: round(totalCompleteEventMs),
    threadGroups: Object.fromEntries(Object.entries(threadGroups).map(([key, value]) => [key, round(value)])),
    topEvents: Array.from(byName.values())
      .map((event) => ({ ...event, totalMs: round(event.totalMs), maxMs: round(event.maxMs) }))
      .sort((left, right) => right.totalMs - left.totalMs || right.maxMs - left.maxMs || left.name.localeCompare(right.name))
      .slice(0, 40),
  };
}

function summarizeSyncTelemetry(syncSnapshot) {
  const events = Array.isArray(syncSnapshot?.events) ? syncSnapshot.events : [];
  return events
    .map((event) => ({
      name: String(event.name ?? ''),
      count: Number(event.count ?? 0),
      totalMs: round(Number(event.totalMs ?? 0)),
      maxMs: round(Number(event.maxMs ?? 0)),
      slowCount: Number(event.slowCount ?? 0),
      fields: event.fields ?? {},
      fieldStats: event.fieldStats ?? {},
    }))
    .filter((event) => event.name)
    .sort((left, right) => right.totalMs - left.totalMs || right.count - left.count || left.name.localeCompare(right.name));
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_APP_URL,
    session: DEFAULT_AGENT_BROWSER_SESSION,
    devKey: DEFAULT_DEV_KEY,
    outDir: null,
    durationMs: 20000,
    plan: 'full',
    printPlan: false,
    skipAuth: false,
    skipTrace: false,
    skipProfiler: false,
    stressSessionCount: 0,
    targetSessionTitle: 'UI Perf Stress Plan',
    stressPromptFile: null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case '--url': args.url = next() ?? args.url; break;
      case '--session': args.session = next() ?? args.session; break;
      case '--dev-key': args.devKey = next() ?? args.devKey; break;
      case '--out-dir': args.outDir = next() ?? args.outDir; break;
      case '--duration-ms': args.durationMs = normalizePositiveInt(next(), args.durationMs); break;
      case '--plan': args.plan = next() ?? args.plan; break;
      case '--target-session-title': args.targetSessionTitle = next() ?? args.targetSessionTitle; break;
      case '--stress-sessions': args.stressSessionCount = normalizeNonNegativeInt(next(), args.stressSessionCount); break;
      case '--stress-prompt-file': args.stressPromptFile = next() ?? args.stressPromptFile; break;
      case '--print-plan': args.printPlan = true; break;
      case '--skip-auth': args.skipAuth = true; break;
      case '--skip-trace': args.skipTrace = true; break;
      case '--skip-profiler': args.skipProfiler = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return `Usage: node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs [options]\n\nOptions:\n  --url <url>                         Web app URL (default: ${DEFAULT_APP_URL})\n  --session <name>                    agent-browser session name\n  --dev-key <key>                     dev restore key for login\n  --out-dir <dir>                     artifact directory\n  --duration-ms <ms>                  per-scenario duration\n  --plan <full|smoke|multi-stream>    scenario subset\n  --target-session-title <title>      session title to open for session-view scenarios\n  --stress-sessions <n>               create n safe long-running stress sessions before measurement\n  --stress-prompt-file <path>         custom base stress prompt\n  --skip-auth                         assume already logged in\n  --skip-trace                        do not capture Chrome traces\n  --skip-profiler                     do not capture CPU profiles\n  --print-plan                        print plan JSON and exit\n  --dry-run                           write plan only, no browser work\n`;
}

export function resolveScenarioExecutionPhases(action) {
  switch (action) {
    case 'sessionListIdle':
      return { prepare: 'root', measure: 'idle' };
    case 'sessionListScroll':
      return { prepare: 'root', measure: 'scroll' };
    case 'sessionListSearch':
      return { prepare: 'root', measure: 'search' };
    case 'newSessionOpen':
      return { prepare: 'newSession', measure: 'idle' };
    case 'newSessionComposerTyping':
      return { prepare: 'newSession', measure: 'composerTyping' };
    case 'sessionViewIdle':
    case 'sessionViewStreamingIdle':
    case 'multiSessionStreamingSidebarVisible':
      return { prepare: 'targetSession', measure: 'idle' };
    case 'sessionViewTranscriptScroll':
      return { prepare: 'targetSession', measure: 'scroll' };
    case 'sessionViewTabs':
      return { prepare: 'targetSession', measure: 'tabs' };
    case 'mobileHiddenSessionList':
      return { prepare: 'mobileTargetSession', measure: 'idle' };
    default:
      throw new Error(`Unhandled scenario action: ${action}`);
  }
}

function selectPlanScenarios(plan, subset) {
  if (subset === 'smoke') {
    const ids = new Set([
      'desktop.sessionList.idle',
      'desktop.sessionList.scroll',
      'desktop.sessionView.idle',
      'desktop.sessionView.transcriptScroll',
    ]);
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => ids.has(scenario.id)) };
  }
  if (subset === 'multi-stream') {
    const ids = new Set([
      'desktop.sessionView.idle',
      'desktop.sessionView.streamingIdle',
      'desktop.multiSessionStreaming.sidebarVisible',
    ]);
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => ids.has(scenario.id)) };
  }
  return plan;
}

function buildArtifactDir(outDir) {
  if (outDir) return resolve(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(homedir(), '.happier', 'perf-audits', 'remote-dev-ui', stamp);
}

function agentBrowserArgs(session, args) {
  return ['--session', session, ...args];
}

async function execAgentBrowser(session, args, options = {}) {
  const commandArgs = agentBrowserArgs(session, args);
  const timeout = options.timeout ?? 120000;
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile('agent-browser', commandArgs, { timeout, maxBuffer: 30 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = [
          `agent-browser ${commandArgs.join(' ')} failed`,
          stdout?.trim(),
          stderr?.trim(),
          error.message,
        ].filter(Boolean).join('\n');
        rejectPromise(new Error(message));
        return;
      }
      if (options.parseJson === false) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolvePromise(null);
        return;
      }
      try {
        resolvePromise(JSON.parse(trimmed));
      } catch {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

async function browserJson(session, args, options) {
  return execAgentBrowser(session, [...args, '--json'], options);
}

async function stopActiveBrowserCaptures(ctx, label) {
  const safeLabel = String(label ?? 'capture').replace(/[^a-z0-9_.-]+/gi, '_');
  const profilePath = join(ctx.outDir, `${safeLabel}.recovered.cpuprofile`);
  const tracePath = join(ctx.outDir, `${safeLabel}.recovered.trace.json`);
  await execAgentBrowser(ctx.session, ['profiler', 'stop', profilePath], { parseJson: false, timeout: 30000 }).catch(() => null);
  await execAgentBrowser(ctx.session, ['trace', 'stop', tracePath], { parseJson: false, timeout: 30000 }).catch(() => null);
}

async function startBrowserCapture(ctx, kind) {
  try {
    await execAgentBrowser(ctx.session, [kind, 'start'], { parseJson: false, timeout: 30000 });
  } catch (error) {
    if (!isAgentBrowserCaptureAlreadyActiveError(error?.message)) throw error;
    await stopActiveBrowserCaptures(ctx, `${kind}-preexisting`);
    await execAgentBrowser(ctx.session, [kind, 'start'], { parseJson: false, timeout: 30000 });
  }
}

async function browserEval(session, js, options) {
  const response = await browserJson(session, ['eval', js], options);
  if (response?.success === false) throw new Error(response.error ?? 'browser eval failed');
  return response?.data?.result;
}

async function waitMs(session, ms) {
  await browserJson(session, ['wait', String(ms)], { timeout: ms + 30000 });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildInstallProbeScript() {
  return `(() => {
    const globalKey = ${JSON.stringify(AUDIT_GLOBAL)};
    const previous = window[globalKey];
    if (previous && typeof previous.disconnect === 'function') previous.disconnect();
    const state = {
      startedAtMs: performance.now(),
      finishedAtMs: null,
      longTasks: [],
      frameGaps: [],
      ws: { messageCount: 0, totalBytes: 0, byType: {}, byUpdateType: {} },
      errors: [],
      rafActive: true,
      lastFrameAtMs: performance.now(),
      observers: [],
      originalWebSocket: window.WebSocket,
    };
    const safeNumber = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            name: entry.name,
            startTime: safeNumber(entry.startTime),
            duration: safeNumber(entry.duration),
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      state.observers.push(observer);
    } catch {}
    function frameLoop(now) {
      if (!state.rafActive) return;
      const gap = now - state.lastFrameAtMs;
      if (gap >= 24) state.frameGaps.push(safeNumber(gap));
      state.lastFrameAtMs = now;
      requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);
    function readUpdateType(payload) {
      try {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : null;
        const body = parsed && typeof parsed === 'object' ? (parsed.body ?? parsed[1]?.body ?? parsed[0]?.body) : null;
        const updateType = body?.updateType ?? body?.type ?? parsed?.updateType ?? parsed?.type;
        return typeof updateType === 'string' ? updateType : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    try {
      const NativeWebSocket = window.WebSocket;
      if (typeof NativeWebSocket === 'function') {
        function AuditedWebSocket(...args) {
          const socket = new NativeWebSocket(...args);
          socket.addEventListener('message', (event) => {
            const data = event.data;
            const bytes = typeof data === 'string' ? data.length : (data?.byteLength ?? 0);
            const updateType = readUpdateType(data);
            state.ws.messageCount += 1;
            state.ws.totalBytes += bytes;
            state.ws.byUpdateType[updateType] = (state.ws.byUpdateType[updateType] || 0) + 1;
          });
          return socket;
        }
        AuditedWebSocket.prototype = NativeWebSocket.prototype;
        AuditedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
        AuditedWebSocket.OPEN = NativeWebSocket.OPEN;
        AuditedWebSocket.CLOSING = NativeWebSocket.CLOSING;
        AuditedWebSocket.CLOSED = NativeWebSocket.CLOSED;
        window.WebSocket = AuditedWebSocket;
      }
    } catch (error) {
      state.errors.push(String(error?.message ?? error));
    }
    window[globalKey] = {
      snapshot() {
        state.finishedAtMs = performance.now();
        const memory = performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        } : null;
        return {
          startedAtMs: state.startedAtMs,
          finishedAtMs: state.finishedAtMs,
          longTasks: state.longTasks.slice(),
          frameGaps: state.frameGaps.slice(),
          ws: JSON.parse(JSON.stringify(state.ws)),
          memory,
          errors: state.errors.slice(),
          url: location.href,
          syncPerformance: window.__HAPPIER_SYNC_PERFORMANCE__?.snapshot?.() ?? null,
          syncReliability: window.__HAPPIER_SYNC_RELIABILITY__?.snapshot?.() ?? null,
        };
      },
      disconnect() {
        state.rafActive = false;
        for (const observer of state.observers) {
          try { observer.disconnect(); } catch {}
        }
        try { window.WebSocket = state.originalWebSocket; } catch {}
      },
    };
    return true;
  })()`;
}

function buildScrollScript(durationMs) {
  return `(() => new Promise((resolve) => {
    const candidates = [document.scrollingElement, ...document.querySelectorAll('*')]
      .filter(Boolean)
      .filter((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width < 80 || rect.height < 80) return false;
        return (el.scrollHeight || 0) > (el.clientHeight || 0) + 80;
      })
      .sort((a, b) => ((b.clientHeight || 0) * (b.clientWidth || 0)) - ((a.clientHeight || 0) * (a.clientWidth || 0)));
    const target = candidates[0] || document.scrollingElement || document.body;
    const started = performance.now();
    const duration = ${normalizePositiveInt(durationMs, 8000)};
    let direction = 1;
    function step(now) {
      const elapsed = now - started;
      target.scrollTop += direction * 48;
      if (target.scrollTop <= 0) direction = 1;
      if (target.scrollTop + target.clientHeight >= target.scrollHeight - 2) direction = -1;
      if (elapsed >= duration) {
        resolve({ scrollTop: target.scrollTop, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight });
        return;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }))()`;
}

function buildFocusFirstTextboxScript() {
  return `(() => {
    const candidates = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"]'));
    const visible = candidates.find((el) => {
      const rect = el.getBoundingClientRect?.();
      return rect && rect.width > 20 && rect.height > 10;
    });
    if (!visible) return false;
    visible.focus();
    return true;
  })()`;
}

async function configureTelemetryAndReload(ctx) {
  await browserJson(ctx.session, ['open', ctx.url], { timeout: 90000 });
  await browserEval(ctx.session, `localStorage.setItem(${JSON.stringify(SYNC_TUNING_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(buildSyncTuningOverride()))}); true;`);
  await browserJson(ctx.session, ['reload'], { timeout: 90000 });
  await waitMs(ctx.session, 3000);
}

async function cleanupTelemetry(ctx) {
  try {
    await browserEval(ctx.session, `localStorage.removeItem(${JSON.stringify(SYNC_TUNING_STORAGE_KEY)}); window.${AUDIT_GLOBAL}?.disconnect?.(); true;`, { timeout: 30000 });
  } catch {}
}

function refByRoleName(snapshotResponse, role, namePattern) {
  const refs = snapshotResponse?.data?.refs ?? {};
  for (const [ref, meta] of Object.entries(refs)) {
    if (meta?.role !== role) continue;
    if (!namePattern.test(String(meta?.name ?? ''))) continue;
    return `@${ref}`;
  }
  return null;
}

async function ensureAuthenticated(ctx) {
  await browserJson(ctx.session, ['open', ctx.url], { timeout: 90000 });
  await waitMs(ctx.session, 1000);
  let snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 90000 });
  const text = snapshot?.data?.snapshot ?? '';
  if (/Search sessions|Start New Session|Sessions/.test(text)) return;

  const loginRef = refByRoleName(snapshot, 'button', /Login/i);
  if (loginRef) {
    await browserJson(ctx.session, ['click', loginRef]);
    await waitMs(ctx.session, 500);
    snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 90000 });
  }

  const restoreRef = refByRoleName(snapshot, 'button', /Restore with Secret Key/i);
  if (restoreRef) {
    await browserJson(ctx.session, ['click', restoreRef]);
    await waitMs(ctx.session, 500);
    snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 90000 });
  }

  const textboxRef = refByRoleName(snapshot, 'textbox', /XXXXX|secret|key|restore/i);
  const restoreAccountRef = refByRoleName(snapshot, 'button', /Restore Account/i);
  if (!textboxRef || !restoreAccountRef) {
    throw new Error('Could not find dev-key restore controls in the UI');
  }
  await browserJson(ctx.session, ['fill', textboxRef, ctx.devKey], { timeout: 30000 });
  await browserJson(ctx.session, ['click', restoreAccountRef], { timeout: 30000 });
  await waitMs(ctx.session, 5000);
}

async function openRoot(ctx) {
  await browserJson(ctx.session, ['set', 'viewport', String(VIEWPORTS.desktop.width), String(VIEWPORTS.desktop.height)], { timeout: 30000 });
  await browserJson(ctx.session, ['open', ctx.url], { timeout: 90000 });
  await waitMs(ctx.session, 1500);
}

async function openNewSession(ctx) {
  await browserJson(ctx.session, ['open', new URL('/new?happier_hmr=0', ctx.url).href], { timeout: 90000 });
  await waitMs(ctx.session, 1500);
}

async function openTargetSession(ctx) {
  await openRoot(ctx);
  if (ctx.targetSessionTitle) {
    try {
      await browserJson(ctx.session, ['find', 'text', ctx.targetSessionTitle, 'click'], { timeout: 20000 });
      await waitMs(ctx.session, 2500);
      const urlResponse = await browserJson(ctx.session, ['get', 'url'], { timeout: 30000 });
      if (String(urlResponse?.data?.url ?? '').includes('/session/')) return;
    } catch {}
  }
  const clicked = await browserEval(ctx.session, `(() => {
    const controls = new Set(['Search sessions', 'Filter by tags', 'View options', 'Archived Sessions']);
    const elements = Array.from(document.querySelectorAll('a,button,[role="button"],div,span'));
    const candidate = elements.find((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length < 4 || controls.has(text)) return false;
      if (/Search sessions|Filter by tags|View options|Archived Sessions|Backup your secret key/.test(text)) return false;
      const rect = el.getBoundingClientRect?.();
      return rect && rect.width > 100 && rect.height > 20 && rect.top > 80;
    });
    if (!candidate) return false;
    candidate.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Could not locate a session row to open');
  await waitMs(ctx.session, 2500);
}

async function typeIntoFocusedTextbox(ctx, text) {
  const focused = await browserEval(ctx.session, buildFocusFirstTextboxScript());
  if (!focused) throw new Error('Could not focus a composer textbox');
  await browserJson(ctx.session, ['keyboard', 'type', text], { timeout: 60000 });
}

async function createStressSessions(ctx, count) {
  if (count <= 0) return [];
  const created = [];
  const basePrompt = ctx.stressPromptFile
    ? await readFile(resolve(ctx.stressPromptFile), 'utf8')
    : DEFAULT_STRESS_TEST_PROMPT;
  for (let index = 0; index < count; index += 1) {
    const scratchDir = join('/tmp', `happier-ui-perf-stress-${Date.now()}-${index}`);
    const prompt = buildSafeStressPrompt({ scratchDir, basePrompt });
    await openNewSession(ctx);
    await typeIntoFocusedTextbox(ctx, prompt);
    let snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 60000 });
    let startRef = refByRoleName(snapshot, 'button', /Start New Session/i);
    if (!startRef) {
      await waitMs(ctx.session, 1000);
      snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 60000 });
      startRef = refByRoleName(snapshot, 'button', /Start New Session/i);
    }
    if (!startRef) throw new Error('Could not find Start New Session button for stress session');
    await browserJson(ctx.session, ['click', startRef], { timeout: 30000 });
    await waitMs(ctx.session, 6000);
    const urlResponse = await browserJson(ctx.session, ['get', 'url'], { timeout: 30000 });
    created.push({ scratchDir, url: urlResponse?.data?.url ?? null });
  }
  return created;
}

async function clickTextIfPresent(ctx, text) {
  try {
    await browserJson(ctx.session, ['find', 'text', text, 'click'], { timeout: 10000 });
    await waitMs(ctx.session, 500);
    return true;
  } catch {
    return false;
  }
}

async function prepareScenarioSurface(ctx, scenario) {
  const phases = resolveScenarioExecutionPhases(scenario.action);
  switch (phases.prepare) {
    case 'root':
      await openRoot(ctx);
      return phases;
    case 'newSession':
      await openNewSession(ctx);
      return phases;
    case 'targetSession':
      await openTargetSession(ctx);
      return phases;
    case 'mobileTargetSession':
      await browserJson(ctx.session, ['set', 'viewport', String(VIEWPORTS.mobile.width), String(VIEWPORTS.mobile.height)], { timeout: 30000 });
      await openTargetSession(ctx);
      return phases;
    default:
      throw new Error(`Unhandled scenario preparation: ${phases.prepare}`);
  }
}

async function runMeasuredScenarioAction(ctx, scenario, phases) {
  switch (phases.measure) {
    case 'idle':
      await waitMs(ctx.session, scenario.durationMs);
      return;
    case 'scroll':
      await browserEval(ctx.session, buildScrollScript(scenario.durationMs), { timeout: scenario.durationMs + 30000 });
      return;
    case 'search':
      await clickTextIfPresent(ctx, 'Search sessions');
      await typeIntoFocusedTextbox(ctx, 'perf');
      await waitMs(ctx.session, Math.max(1000, scenario.durationMs - 1500));
      await browserJson(ctx.session, ['press', 'Escape'], { timeout: 10000 }).catch(() => null);
      return;
    case 'composerTyping':
      await typeIntoFocusedTextbox(ctx, 'Please write a concise markdown performance smoke test with a list, a table, and a code fence.');
      await waitMs(ctx.session, Math.max(1000, scenario.durationMs - 2000));
      return;
    case 'tabs':
      for (const label of ['Files', 'Git', 'Agents', 'Runs', 'Details', 'Transcript']) {
        await clickTextIfPresent(ctx, label);
        await waitMs(ctx.session, Math.max(500, Math.trunc(scenario.durationMs / 12)));
      }
      await waitMs(ctx.session, Math.max(1000, Math.trunc(scenario.durationMs / 3)));
      return;
    default:
      throw new Error(`Unhandled scenario measurement: ${phases.measure}`);
  }
}

async function collectScenarioSnapshot(ctx) {
  const raw = await browserEval(ctx.session, `window.${AUDIT_GLOBAL}?.snapshot?.() ?? null`, { timeout: 60000 });
  if (!raw) throw new Error('Browser perf probe snapshot was not available');
  return {
    raw,
    browserSummary: summarizeBrowserProbe(raw),
    syncTopEvents: summarizeSyncTelemetry(raw.syncPerformance).slice(0, 80),
  };
}

async function runScenario(ctx, scenario) {
  const safeId = scenario.id.replace(/[^a-z0-9_.-]+/gi, '_');
  const tracePath = join(ctx.outDir, `${safeId}.trace.json`);
  const profilePath = join(ctx.outDir, `${safeId}.cpuprofile`);
  await browserJson(ctx.session, ['set', 'viewport', String(VIEWPORTS[scenario.viewport].width), String(VIEWPORTS[scenario.viewport].height)], { timeout: 30000 });
  const phases = await prepareScenarioSurface(ctx, scenario);
  await browserEval(ctx.session, buildInstallProbeScript(), { timeout: 30000 });
  await browserEval(ctx.session, 'window.__HAPPIER_SYNC_PERFORMANCE__?.reset?.(); true;', { timeout: 30000 });

  const shouldTrace = scenario.trace && !ctx.skipTrace;
  // agent-browser exposes trace and CPU profiler through the same active capture slot.
  // Prefer trace for UI/GPU work because it includes renderer/compositor/Viz threads; run
  // the same plan with --skip-trace when an isolated .cpuprofile is needed.
  const shouldProfile = scenario.profiler && !ctx.skipProfiler && !shouldTrace;
  await stopActiveBrowserCaptures(ctx, `${safeId}-preflight`);
  if (shouldTrace) await startBrowserCapture(ctx, 'trace');
  if (shouldProfile) await startBrowserCapture(ctx, 'profiler');

  const startedAt = new Date().toISOString();
  let error = null;
  try {
    await runMeasuredScenarioAction(ctx, scenario, phases);
  } catch (caught) {
    error = caught?.message ?? String(caught);
  }

  if (shouldProfile) {
    try { await execAgentBrowser(ctx.session, ['profiler', 'stop', profilePath], { parseJson: false, timeout: 60000 }); } catch (caught) { error = error ?? caught?.message ?? String(caught); }
  }
  if (shouldTrace) {
    try { await execAgentBrowser(ctx.session, ['trace', 'stop', tracePath], { parseJson: false, timeout: 60000 }); } catch (caught) { error = error ?? caught?.message ?? String(caught); }
  }

  const snapshot = await collectScenarioSnapshot(ctx).catch((caught) => ({ error: caught?.message ?? String(caught) }));
  const traceSummary = shouldTrace && existsSync(tracePath)
    ? summarizeChromeTrace(JSON.parse(await readFile(tracePath, 'utf8')))
    : null;
  const result = {
    scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    error,
    artifacts: {
      trace: shouldTrace ? tracePath : null,
      profile: shouldProfile ? profilePath : null,
    },
    ...snapshot,
    traceSummary,
  };
  await writeJson(join(ctx.outDir, `${safeId}.json`), result);
  return result;
}

function buildRunSummary(results) {
  return {
    scenarios: results.map((result) => ({
      id: result.scenario?.id,
      title: result.scenario?.title,
      error: result.error ?? result.raw?.error ?? null,
      browserSummary: result.browserSummary ?? null,
      topSyncEvents: result.syncTopEvents?.slice(0, 15) ?? [],
      traceThreadGroups: result.traceSummary?.threadGroups ?? null,
      traceTopEvents: result.traceSummary?.topEvents?.slice(0, 15) ?? [],
    })),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const plan = selectPlanScenarios(buildDefaultPerfAuditPlan({ defaultDurationMs: args.durationMs }), args.plan);
  if (args.printPlan) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const outDir = buildArtifactDir(args.outDir);
  await mkdir(outDir, { recursive: true });
  await writeJson(join(outDir, 'plan.json'), plan);
  if (args.dryRun) {
    await writeJson(join(outDir, 'summary.json'), { dryRun: true, plan });
    process.stdout.write(`${outDir}\n`);
    return;
  }

  const ctx = {
    ...args,
    outDir,
  };

  const stressSessions = [];
  const results = [];
  try {
    if (!args.skipAuth) await ensureAuthenticated(ctx);
    await configureTelemetryAndReload(ctx);
    if (args.stressSessionCount > 0) {
      stressSessions.push(...await createStressSessions(ctx, args.stressSessionCount));
      await writeJson(join(outDir, 'stress-sessions.json'), stressSessions);
    }
    for (const scenario of plan.scenarios) {
      if (scenario.requiresStressSessions && args.stressSessionCount <= 0) {
        results.push({ scenario, error: 'skipped: requires --stress-sessions > 0', skipped: true });
        continue;
      }
      results.push(await runScenario(ctx, scenario));
    }
  } finally {
    await cleanupTelemetry(ctx);
  }

  const summary = {
    outDir,
    url: args.url,
    plan: args.plan,
    stressSessions,
    ...buildRunSummary(results),
  };
  await writeJson(join(outDir, 'summary.json'), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile && currentFile === invokedFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
