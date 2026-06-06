# Happier CLI Instructions

Package-specific instructions for `apps/cli` (`@happier-dev/cli`). Read the repository root `AGENTS.md` first. More-specific rules here override root rules.

## Ownership

The CLI owns local runtime, daemon control, provider execution, authentication, local machine/session control, binary-safe tooling, and published CLI packaging.

Primary areas:
- `src/index.ts` / `src/cli/**` — command parsing and dispatch.
- `src/backends/catalog.ts` + `src/backends/<provider>/**` — executable provider wiring.
- `src/agent/**` — provider-agnostic agent runtime, ACP plumbing, transports, adapters, factories.
- `src/api/**` — server communication, encryption, queues, RPC clients.
- `src/daemon/**` — daemon lifecycle, session spawning, diagnostics, local control.
- `src/integrations/**`, `src/terminal/**`, `src/ui/**`, `src/features/**`, `src/utils/**` — package-local runtime domains.

## Commands and validation

Use yarn. For TypeScript changes, run:

```bash
yarn workspace @happier-dev/cli typecheck
```

Use the smallest relevant test slice while iterating and broaden before handoff. CLI unit tests must not force a full CLI `dist` build.

## TypeScript and hygiene

- Strict typing is mandatory; avoid untyped escape hatches.
- Prefer explicit exported types and named exports.
- Keep imports at the top of files.
- Prefer small cohesive modules and explicit file names.
- Do not write debug output to stdout/stderr in agent session paths.
- Use package logging facilities for file logs so provider terminal UIs are not disturbed.
- Never log secrets, tokens, encrypted secret plaintext, or environment secret values.

## Provider/backend architecture

- Treat `src/backends/catalog.ts` + `src/backends/<provider>/index.ts` as the canonical executable provider registry.
- Provider-specific execution belongs inside `src/backends/<provider>/**`.
- Core domains (`src/agent`, `src/api`, `src/daemon`, `src/rpc`, `src/session`, `src/terminal`) must stay provider-agnostic unless inside a provider folder.
- If a cross-provider feature needs provider-specific execution, extend `AgentCatalogEntry` in `src/backends/types.ts` and implement the hook in provider entries.
- Declarative provider support/capability facts belong in `packages/agents/*`.

Details: `../../docs/agents-catalog.md`.

## CLI terminal and integrations ownership

- `src/terminal/**` owns provider-agnostic terminal runtime, attachment, metadata, and terminal UX/domain behavior.
- `src/integrations/**` owns concrete OS/tool integrations such as `tmux`, difftastic, proxy, tailscale, and watchers.
- Reuse existing integration owners such as `src/integrations/tmux/**` for concrete tool behavior. Add a sibling integration folder only when introducing a real new integration owner.
- Do not create `src/integrations/terminal/**` just to shorten names. Use it only if `terminal` is genuinely becoming an integrations parent with meaningful sibling subdomains.
- A compound domain folder such as `src/integrations/terminalHost/**` is acceptable when “terminal host” is the actual seam being introduced.
- Provider-specific terminal runtime belongs under the owning provider folder; shared terminal abstractions belong under the provider-agnostic `src/terminal/**` or the concrete integration owner.

## Daemon and process behavior

- Daemon lifecycle, state files, local HTTP control, backend sockets, spawn hooks, and session tracking are runtime behavior; use TDD for changes.
- Preserve graceful shutdown and stale-process cleanup semantics.
- Keep local control endpoints authenticated/validated according to existing daemon helpers.
- Reuse daemon-owned process/session helpers instead of adding ad hoc spawning or cleanup.

## Binary-safe runtime and packaging

- First-party runtime paths must work without system Node/package managers. Use managed runtime/tooling abstractions.
- Do not directly spawn `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx` in product runtime paths.
- Backend CLIs should prefer user/system installs by default unless source preference says otherwise.
- Add dependencies to the package that imports them. If an internal workspace is used at runtime by the CLI, keep `apps/cli` bundling metadata and bundling tests in sync.

Details: `../../docs/binary-runtime.md` and `../../docs/cli-architecture.md`.
