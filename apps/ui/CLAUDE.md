# Happier UI Instructions

Package-specific instructions for `apps/ui`. Read the repository root `AGENTS.md` first. More-specific rules here override root rules.

## Commands

Use yarn.

- `yarn start` — Expo development server.
- `yarn ios` / `yarn android` / `yarn web` — platform targets.
- `yarn typecheck` — required after TypeScript changes.
- `yarn test` — Vitest tests.
- `yarn tauri:dev` / `yarn tauri:build:*` — desktop flows.

## Structure

- Expo Router routes live in `sources/app/**`.
- Keep routes as screen entrypoints; extract non-trivial UI/logic into `sources/components/**`.
- Keep `components/`, `hooks/`, `utils/`, and `sync/` roots thin; prefer domain subfolders.
- Use alias imports (`@/components/...`, `@/hooks/...`, `@/utils/...`, `@/sync/...`).
- During moves, update imports in the same change and do not leave compatibility wrappers by default.
- Buckets are lowercase; feature folders are camelCase; avoid `_folders` except Expo Router files and `__tests__`.
- Use `components/sessions/**`, not singular `components/session/**`.

## Sync boundaries

- `sources/sync/sync.ts` is the public sync orchestrator/wiring entrypoint.
- `sync/api/**`: request/response adapters and protocol mapping.
- `sync/runtime/**`: small cross-cutting runtime helpers.
- `sync/encryption/**`: encryption/decryption/sealing/share-key crypto helpers.
- `sync/engine/**`: orchestration/effectful runtime flows.
- `sync/store/**`: state domains/selectors/normalization and persistence-facing state shape.
- `sync/domains/**`: domain-owned behavior; domain modules must not depend on `sync/store/**`.
- `sync/ops/**`: orchestration-facing operation entrypoints.

## Provider registry architecture

- Generic UI/sync/screens consume provider behavior through `sources/agents/catalog/**`, `sources/agents/registry/**`, and shared abstractions.
- Provider-owned UI behavior belongs under `sources/agents/providers/<provider>/**`.
- Do not branch on provider names in generic screens/components/sync logic when the registry can expose the behavior.
- Extend the canonical registry/core entry shapes for new provider-specific UI behavior.

Details: `../../docs/agents-catalog.md`.

## Theme, typography, and i18n

- No hardcoded colors or raw hex/rgb values in UI code. Use Unistyles theme tokens.
- Icons must use themed colors/tints/backgrounds.
- Use app text primitives from `@/components/ui/text/Text` and `TextInput` so in-app font scaling works.
- Avoid hardcoded font sizes in new UI code; use existing scalable primitives/metrics.
- All user-visible strings, accessibility labels, and placeholders must use `t(...)` and be added to every locale under `sources/text/translations/`.
- Re-read translation files before adding keys; reuse common keys when appropriate.

## UI primitives and interaction

- Never use React Native `Alert`; use `@/modal`.
- Use app `Popover` + `FloatingOverlay` for menus/tooltips/context menus.
- Follow existing modal/popover portal behavior and Radix CJS entrypoints for web dialog primitives.
- Apply layout width constraints from `@/components/layout` to full-screen ScrollViews/content containers.
- For settings list screens, keep existing-object lists separate from creation/attachment action groups.
- Worktrees must remain usable without first creating a workspace.

## Testing

- Prefer UI-local testkit imports from `@/dev/testkit` and helpers under `sources/dev/testkit/**`.
- Do not introduce inline mocks for common boundaries (`expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, storage) when the testkit owns the boundary.
- Avoid brittle assertions on exact copy, colors, raw style objects, or implementation details unless they are the actual contract.
