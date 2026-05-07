# Promotion Commands

## Preview Dry-Run

```bash
node scripts/pipeline/run.mjs release \
  --confirm "release dev to preview" \
  --repository happier-dev/happier \
  --deploy-environment preview \
  --deploy-targets ui,server,website,docs,cli,server_runner \
  --bump none \
  --dry-run
```

## Preview Execute

Ask for explicit human approval immediately before removing `--dry-run`.

```bash
node scripts/pipeline/run.mjs release \
  --confirm "release dev to preview" \
  --repository happier-dev/happier \
  --deploy-environment preview \
  --deploy-targets ui,server,website,docs,cli,server_runner \
  --bump none
```

## Production

Production promotion is a separate human decision after preview soak. Prefer `release preview to main`, not direct `dev to main`, unless explicitly requested.

Production dry-run:

```bash
node scripts/pipeline/run.mjs release \
  --confirm "release preview to main" \
  --repository happier-dev/happier \
  --deploy-environment production \
  --deploy-targets ui,server,website,docs,cli,server_runner \
  --bump none \
  --dry-run
```

Ask for explicit human approval immediately before removing `--dry-run`.

## Post-Promotion Verification

When `release.yml` runs with `checks_profile=full`, it invokes `.github/workflows/release-verify.yml` after publish lanes. Monitor and record that result. The reusable verification workflow covers installer smoke, binary smoke, CLI update continuity, daemon continuity, and session continuity according to its inputs/defaults.

If the release profile does not invoke `release-verify.yml`, record that explicitly and decide whether to dispatch it manually for the released channel.

Deploy branch/webhook execution may be protected by Cloudflare Access. Required tokens are external side-effect credentials; ask for them or stop if unavailable.
