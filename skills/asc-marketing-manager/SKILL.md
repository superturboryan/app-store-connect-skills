---
name: asc-marketing-manager
description: Sync App Store Connect marketing metadata and localized screenshot assets safely, including localized text fields, App Review fields, release-version setup, and screenshot upload/replacement from local folders. Use when updating App Store copy, uploading screenshots, or starting a new editable App Store version.
---

# Workflow

Use this skill to update App Store Connect text metadata and screenshot assets with a dry-run-first
workflow.

## Text Metadata Workflow

1. Confirm the target app, version, and credential env file.
2. If using Google Sheets, read `references/google-sheet-localizations.md` first.
   - sheet ID from `ASC_SHEET_ID`
   - tab from `ASC_SHEET_NAME`; if omitted, use the confirmed target version
   - if `ASC_SHEET_ID` is missing or the spreadsheet cannot be found, create a native Google
     Sheet with the Google Sheets connector before asking the user to fill copy
   - after reading sheet values through the connector, use the dependency-free mapper in
     `lib/sheet-mapper.mjs` to convert the 2D range into desired JSON
   - new sheets should follow the default localization layout: a `Pages` tab plus one version tab
     with headers `Name`, `Subtitle`, `Promotional Text`, `Description`, `What's new`, `Keywords`
3. Build a transient desired-state JSON in `/private/tmp`.
   - If the sheet is edited manually after JSON generation or after a dry-run, re-read the sheet,
     rerun the mapper, and regenerate JSON before another dry-run or apply.
   - For newly added locales, include both `appInfo.locales` (`name`, `subtitle`) and
     `version.locales` in the first desired JSON. Default `name` from the primary English row
     unless the app intentionally localizes its brand/title; localize the `subtitle`.
   - App `name` and `subtitle` must not include Apple device names such as `iPhone`, `iPad`,
     `Apple Watch`, `Apple TV`, `Apple Vision`, or `Vision Pro`; use generic wording like
     `phone`, `watch`, or localized equivalents.
   - If App Store Connect rejects app-info create/update because of app state, report the blocked
     `name`/`subtitle` fields explicitly, then retry/apply a version-locales-only JSON so
     promotional text, description, what's new, and keywords can still sync.
4. Run the bundled script with `--dry-run`.
5. Require explicit user confirmation before running `--apply`. If the user already gave explicit
   apply intent before the dry-run, a clean dry-run immediately before apply is sufficient.
6. After apply, rely on the script's re-fetch verification before reporting success.

If the user's prompt does not specify which App Store version to edit or create, stop and ask for
the target version before reading sheets or running the script. Use `--ensure-version` only when
the user wants to start a new editable release. Dry-run reports the version creation; apply creates
it.

## Screenshot Asset Workflow

Use this workflow for App Store screenshots only. App previews, review attachments, build selection,
submission, phased release, routing coverage, and rating reset remain future scope.

1. Confirm the target app, version, credential env file, and local screenshot asset folder.
2. Read `references/asset-folder-screenshots.md` before interpreting folder structure.
3. Run `scripts/asc-sync-assets.mjs` with `--dry-run` first.
   - The script infers one ASC locale and one screenshot display type from each screenshot path.
   - Supported shapes include `assets/en-US/APP_IPHONE_67/01-home.png` and
     `assets/APP_IPHONE_67/en-US/01-home.png`.
   - Use `--folder-shape locale-first` or `--folder-shape display-first` when the user wants a
     stricter convention; default `auto` accepts mixed nested folders when each path is unambiguous.
   - Filenames with leading numbers determine order, for example `01-home.png`, `02-search.png`,
     `10-settings.png`.
4. If folder inference is ambiguous, stop and ask the user how locale/display folders should map
   before applying.
5. Require explicit user confirmation before running `--apply`. Apply mode replaces each targeted
   ASC screenshot set with the files found in the matching local folder target.
6. After apply, rely on the script's upload commit, ordering, and processing verification before
   reporting success.

## Scripts

Use `scripts/asc-sync-metadata.mjs`.

```zsh
node scripts/asc-sync-metadata.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --desired /private/tmp/asc-desired-metadata.json \
  --version 2.3.0 \
  --ensure-version \
  --dry-run
```

```zsh
node scripts/asc-sync-metadata.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --desired /private/tmp/asc-desired-metadata.json \
  --version 2.3.0 \
  --ensure-version \
  --apply
```

The script syncs App Store Connect only. It does not read or create Google Sheets directly.

Use `scripts/asc-sync-assets.mjs` for screenshots:

```zsh
node scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --dry-run
```

```zsh
node scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --apply
```

## Desired JSON

Read `references/desired-json-schema.md` before creating desired-state JSON by hand. The current
nested shape separates `appInfo.locales`, `version.locales`, version attributes, and `review`
fields. The old top-level `locales` shape remains supported for `promotionalText` and `whatsNew`.

`appInfo.locales` (`name`, `subtitle`) and `version.locales` (promotional text, description,
keywords, What's New, URLs) are separate ASC resources. If app-level `name` or `subtitle` changes
are rejected due to App Store Connect state, rerun a version-locales-only dry-run/apply so allowed
version metadata can still sync.

## Credentials

Read `references/app-store-connect-credentials.md` before helping a user set up credentials. Never print full key IDs, issuer IDs, JWTs, `.p8` contents, or env files containing secrets.
Tell users to follow the least privilege principle for App Store Connect API keys. Recommend the
**Marketing** role for this skill's current metadata workflows, and do not request or recommend
**Full Access**.

## Safety Rules

- Always dry-run first.
- Do not run `--apply` until the user explicitly asks for it after a clean dry-run.
- Screenshot apply mode replaces targeted ASC screenshot sets; make the destructive replacement
  explicit when summarizing a dry run.
- Keep `.env` and `.p8` files outside repos.
- Do not commit desired JSON if it contains unreleased marketing copy.
- Do not print review passwords, JWTs, `.p8` contents, or env files containing secrets.
- Treat app preview, build selection, review attachment, submission, phased-release creation,
  routing coverage, and rating reset as future/planning scope.
