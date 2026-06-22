# App Store Connect Skills

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![skills.sh](https://skills.sh/b/superturboryan/app-store-connect-skills)](https://skills.sh/superturboryan/app-store-connect-skills)
![Node.js 18+](https://img.shields.io/badge/node-18%2B-339933)
![App Store Connect](https://img.shields.io/badge/App%20Store%20Connect-metadata%20%2B%20screenshots%20%2B%20pricing-0A84FF)

App Store Connect Skills is a `skills.sh` collection for App Store Connect workflows. It bundles
review-first skills for localized metadata, App Review details, screenshot assets, and read-only
regional pricing audits.

The included scripts are dependency-free Node programs that read local desired-state files, talk
directly to App Store Connect, and keep Google Sheets access on the agent connector side.

## Install

Install the collection with `skills.sh`:

```zsh
npx skills add superturboryan/app-store-connect-skills
```

The skills.sh collection page is grouped by [skills.sh.json](/Users/ryan/Developer/Xcode/app-store-connect-skills/skills.sh.json) and should list both bundled skills.

## Use In Codex And Claude

This repository ships skills only. It does not provide Codex plugin packaging or plugin slash
commands.

- Codex: invoke the installed skills with `/skills` or by mentioning `$asc-marketing-manager` or `$asc-pricing-manager`
- Claude: install the skill folders as custom skills, then invoke them by name or let them auto-trigger

For local development in this repository, `.agents/skills/*` symlinks point at the canonical root
skill folders so Codex can discover them directly from the repo.

## Skills

### `asc-marketing-manager`

Use this skill for release metadata and screenshot work:

- localized app name, subtitle, description, keywords, support URL, and marketing URL
- `whatsNew` and `promotionalText`
- App Review contact, demo account, and notes fields
- explicit creation of a missing editable App Store version with `--ensure-version`
- localized App Store screenshot replacement from nested local folders
- Google Sheets connector workflows and desired-state JSON workflows

The metadata and screenshot scripts are dry-run-first and require explicit approval before applying
changes.

### `asc-pricing-manager`

Use this skill for paid-app pricing review:

- current App Store Connect app price schedule lookup
- base territory, manual price, and automatic price audit
- active territory-local customer price grouping by currency
- upcoming and expired schedule row reporting
- generic pricing outlier detection based on active territory price-tier patterns
- read-only pricing recommendations for markets that appear underpriced or priced above the dominant tier
- JSON and CSV audit artifacts written to `/private/tmp` by default

The pricing workflow is read-only in this release. It does not schedule or apply price changes.

## Scope

App previews, build selection, review attachments, submission, phased release, routing coverage, and
rating reset are future scope. App previews should remain a separate workflow because ASC video
assets have different validation and processing failure modes.

## Workflow

Metadata and screenshot workflow:

1. Confirm the app, credential env file, and target App Store version.
2. Build desired-state JSON from a Google Sheet or a checked local JSON file.
3. Run the matching script with `--dry-run`.
4. Review the diff and warnings.
5. Run `--apply` only when the dry run is clean and the user explicitly approves.

Pricing audit workflow:

1. Confirm the app and a pricing-capable credential env file.
2. Run `asc-audit-pricing.mjs`.
3. Review the generated JSON and CSV artifacts from `/private/tmp`, including outliers and recommendations.
4. Review suggested territory price moves before deciding on any future regional pricing matrix.

The skills write transient generated JSON to `/private/tmp` and avoid committing unreleased copy or
credentials.

## Google Sheets

When `ASC_SHEET_ID` points to a spreadsheet, the skill reads it through the Google Sheets connector
and uses the bundled mapper to produce desired JSON. If a sheet is missing, the skill can create a
blank native Google Sheet, then stop until the user fills and reviews the copy.

The default sheet layout is:

- a `Pages` tab for storefront reference URLs
- one version tab named from `ASC_SHEET_NAME` or the confirmed target version
- version-tab headers: version label, `Name`, `Subtitle`, `Promotional Text`, `Description`,
  `What's new`, `Keywords`
- optional `supportUrl` and `marketingUrl` columns after `Keywords`
- `Reviewer Notes` below the localization table

Templates live in [skills/asc-marketing-manager/assets/examples](/Users/ryan/Developer/Xcode/app-store-connect-skills/skills/asc-marketing-manager/assets/examples). Full sheet creation and extraction rules are in [skills/asc-marketing-manager/references/google-sheet-localizations.md](/Users/ryan/Developer/Xcode/app-store-connect-skills/skills/asc-marketing-manager/references/google-sheet-localizations.md).

## Screenshot Assets

Use `asc-sync-assets.mjs` for screenshots. Each screenshot path must contain one ASC locale and one
screenshot display type. Leading filename numbers define order.

```text
AppStoreScreenshots/
  en-US/
    APP_IPHONE_67/
      01-home.png
      02-search.png
  APP_IPHONE_67/
    ja/
      01-home.png
      02-search.png
```

Apply mode replaces each targeted ASC screenshot set with the matching local files. Folder rules
are documented in [skills/asc-marketing-manager/references/asset-folder-screenshots.md](/Users/ryan/Developer/Xcode/app-store-connect-skills/skills/asc-marketing-manager/references/asset-folder-screenshots.md).

## Commands

Metadata dry run:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-metadata.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --desired /private/tmp/asc-desired-metadata.json \
  --version 2.3.0 \
  --dry-run
```

Create a missing editable version during the dry run:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-metadata.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --desired /private/tmp/asc-desired-metadata.json \
  --version 2.3.0 \
  --ensure-version \
  --dry-run
```

Screenshot dry run:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --dry-run
```

Replace `--dry-run` with `--apply` only after reviewing a clean dry run.

Pricing audit:

```zsh
node skills/asc-pricing-manager/scripts/asc-audit-pricing.mjs \
  --env ~/.appstoreconnect/my-app-pricing.env
```

Pricing audit mode is read-only and writes JSON/CSV artifacts to `/private/tmp` by default.

## Credentials

Create an App Store Connect Team API key with the least privilege role that supports the workflow.
For the current metadata and screenshot scope, **Marketing** should be sufficient.
Use a separate pricing-capable key for pricing audits; do not assume the Marketing key can read
pricing resources.

Store credentials outside the repository:

```zsh
mkdir -p ~/.appstoreconnect
chmod 700 ~/.appstoreconnect
chmod 600 ~/.appstoreconnect/*.env
chmod 600 ~/.appstoreconnect/*.p8
```

Required env values:

```zsh
ASC_KEY_ID=<KEY_ID>
ASC_ISSUER_ID=<ISSUER_ID>
ASC_KEY_PATH=/Users/you/.appstoreconnect/AuthKey_<KEY_ID>.p8
ASC_APP_ID=<APP_ID>
ASC_PLATFORM=IOS
ASC_COPYRIGHT=2026 Your Name
ASC_SHEET_ID=<GOOGLE_SHEET_ID>
ASC_SHEET_NAME=<SHEET_TAB_NAME>
```

Keep the target App Store version out of shared credential files. Provide it with `--version` or in
desired JSON as `version.versionString`.

## Desired JSON

The nested desired-state shape separates App Info, App Store Version localization, version
attributes, and App Review details:

```json
{
  "appInfo": {
    "locales": {
      "en-US": {
        "name": "Example App",
        "subtitle": "Music on your watch"
      }
    }
  },
  "version": {
    "versionString": "2.3.0",
    "platform": "IOS",
    "copyright": "2026 Example",
    "releaseType": "MANUAL",
    "usesIdfa": false,
    "locales": {
      "en-US": {
        "promotionalText": "Short promotional text, max 170 characters.",
        "description": "Long App Store description.",
        "keywords": "music,watch,streaming",
        "supportUrl": "https://example.com/support",
        "marketingUrl": "https://example.com",
        "whatsNew": "+ Release note one\n+ Release note two"
      }
    }
  },
  "review": {
    "contactFirstName": "Ada",
    "contactLastName": "Lovelace",
    "contactPhone": "+15555550123",
    "contactEmail": "ada@example.com",
    "demoAccountRequired": true,
    "demoAccountName": "demo@example.com",
    "demoAccountPassword": "secret",
    "notes": "Use the demo account to sign in."
  }
}
```

See [skills/asc-marketing-manager/references/desired-json-schema.md](/Users/ryan/Developer/Xcode/app-store-connect-skills/skills/asc-marketing-manager/references/desired-json-schema.md) for the current schema and field notes.

## Tests

Run the canonical test suite:

```zsh
node --test skills/asc-marketing-manager/tests/*.test.mjs skills/asc-pricing-manager/tests/*.test.mjs
```
