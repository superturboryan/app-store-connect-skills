---
description: Start an App Store Connect metadata, screenshot asset, or pricing audit workflow.
---

# /asc-marketing-manager

Start ASC Marketing Manager for App Store Connect text metadata, screenshot assets, or read-only
pricing audits.

## Arguments

- `env`: path to the App Store Connect env file (optional)
- `desired`: path to desired-state JSON (optional)
- `version`: App Store version string (optional)
- `sheet`: Google Sheet ID or sheet context (optional)
- `assets`: local screenshot asset folder (optional)
- `pricing`: read-only regional pricing audit intent (optional)
- `mode`: `setup`, `dry-run`, or `apply` (optional; default: infer from request)

## Workflow

1. Use `asc-marketing-manager` for metadata or screenshots, and `asc-pricing-manager` for pricing audits.
2. Read the selected skill's `SKILL.md` before making App Store Connect requests.
3. If using Google Sheets, read `references/google-sheet-localizations.md` and use the Google Sheets connector to build transient desired-state JSON in `/private/tmp`.
4. If uploading screenshots, read `references/asset-folder-screenshots.md` and run `asc-sync-assets.mjs`.
5. If auditing pricing, run `asc-audit-pricing.mjs`; it is read-only and writes review artifacts to `/private/tmp` by default.
6. Always run the matching bundled script with `--dry-run` first when a workflow has an apply mode.
7. Do not run `--apply` unless the user explicitly asks after reviewing a clean dry run.
8. Keep credentials, unreleased desired metadata, pricing audits, and unreleased asset folders out of commits unless the user explicitly wants them tracked.

## Guardrails

- Never print full `.env` files, `.p8` contents, JWTs, review passwords, or other credentials.
- Screenshot apply mode replaces targeted screenshot sets; summarize that clearly before apply.
- Pricing audits are read-only; do not schedule price changes from this command.
- Treat app preview, build selection, review attachment, submission, phased-release creation, routing coverage, and rating reset as future scope.
