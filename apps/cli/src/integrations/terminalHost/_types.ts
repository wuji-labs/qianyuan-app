import type {
  TerminalHostKind,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalPromptInput,
} from '@happier-dev/agents';
import type { AttachSurfaceStaticMetadataV1 } from '@happier-dev/protocol';

export type {
  TerminalHostKind,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalPromptInput,
} from '@happier-dev/agents';

export type TerminalHostPreference = 'auto' | TerminalHostKind;

export type TerminalHostAttachMetadata = AttachSurfaceStaticMetadataV1 & Readonly<{
  attachStrategy: 'terminal_host';
}>;

export type TerminalHostHandle = Readonly<{
  kind: TerminalHostKind;
  sessionName: string;
  paneId?: string;
  socketDir?: string;
  expectedCommandFragments?: readonly string[];
  attachMetadata: TerminalHostAttachMetadata;
}>;

export type TerminalHostLiveness = Readonly<{
  paneAlive: boolean;
  paneDead?: boolean;
  panePid?: number;
  paneCurrentCommand?: string;
  paneExitStatus?: number;
  paneScreenDumpCaptured?: boolean;
  paneScreenDumpTruncated?: boolean;
  paneScreenDumpError?: string;
  observedAt: number;
}>;

export type TerminalInputState = Readonly<{
  stable: boolean;
  currentInput: string;
  observedAt: number;
}>;

export type TerminalHostAdapter = Readonly<{
  kind: TerminalHostKind;
  createOrAttachHost(opts: Readonly<{
    sessionName: string;
    workingDirectory: string;
    spawnArgv: readonly string[];
    spawnEnv: Readonly<Record<string, string>>;
    isolatedEnv: boolean;
  }>): Promise<TerminalHostHandle>;
  injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
  interruptTurn(handle: TerminalHostHandle): Promise<void>;
  evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLiveness>;
  captureInputState?(handle: TerminalHostHandle): Promise<TerminalInputState>;
  dispose(handle: TerminalHostHandle): Promise<void>;
}>;

export type TerminalHostResolverPlatform = Readonly<{
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
}>;

export type TerminalHostResolution =
  | Readonly<{ status: 'resolved'; adapter: TerminalHostAdapter; reason: string }>
  | Readonly<{ status: 'disabled'; reason: string; message: string }>;
