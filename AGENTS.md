# App Store Connect Skills Handoff

## Project

`app-store-connect-skills` is a `skills.sh` collection for App Store Connect workflows. It ships
two canonical skill packages under `skills/`:

- `asc-marketing-manager` for localized metadata, App Review fields, and screenshot sync
- `asc-pricing-manager` for read-only paid-app pricing audits

Current local path:

`/Users/ryan/Developer/Xcode/app-store-connect-skills`

Repository layout:

```text
app-store-connect-skills/
  README.md
  AGENTS.md
  LICENSE
  skills.sh.json
  .agents/
    skills/
      asc-marketing-manager -> ../../skills/asc-marketing-manager
      asc-pricing-manager -> ../../skills/asc-pricing-manager
  skills/
    asc-marketing-manager/
      SKILL.md
      agents/
      assets/
      lib/
      references/
      scripts/
      tests/
    asc-pricing-manager/
      SKILL.md
      agents/
      lib/
      scripts/
      tests/
```

The root `skills/` folders are the only published source of truth. `.agents/skills/*` symlinks
exist only so Codex can discover the same skills directly while working inside this repository.

## Current Status

The text metadata expansion package, screenshot asset upload package, and read-only pricing audit
package with generic outlier detection and pricing recommendations have been implemented and tested.

Verification command:

```zsh
cd /Users/ryan/Developer/Xcode/app-store-connect-skills
node --test skills/asc-marketing-manager/tests/*.test.mjs skills/asc-pricing-manager/tests/*.test.mjs
```

## Purpose

The skills help agents sync or audit App Store Connect data, including:

- localized app name
- localized subtitle
- localized description
- localized keywords
- localized support URL
- localized marketing URL
- `whatsNew`
- `promotionalText`
- App Review contact, demo account, and notes text fields
- explicit creation of a missing editable App Store version with `--ensure-version`
- localized screenshot upload/replacement from nested folders with numeric filename ordering
- read-only regional paid-app pricing audits with JSON/CSV output, generic outlier detection, and pricing recommendations

Future scope:

- scheduled price changes
- app previews
- build selection
- review attachments
- submission workflows
- phased-release creation
- routing coverage files
- rating reset

App preview upload should be added as a separate command or workflow because ASC video assets have
additional validation and processing edge cases.

## Important Implementation Details

The scripts are dependency-free Node and use Node built-ins only.

ASC JWT signing must use:

```js
crypto.sign("sha256", Buffer.from(signingInput), {
  key,
  dsaEncoding: "ieee-p1363"
})
```

This matters. A previous Ruby signing attempt returned ASC `401`; the Node `ieee-p1363` signature
worked.

The scripts only talk to App Store Connect and local files. They do not read or create Google
Sheets directly. The skill or agent should read Google Sheets through the Google Sheets connector,
then write transient desired-state JSON to `/private/tmp`.

If `ASC_SHEET_ID` is missing or the spreadsheet cannot be found, the skill can create a native
Google Sheet first. New sheets should follow the default localization format documented in
[skills/asc-marketing-manager/references/google-sheet-localizations.md](/Users/ryan/Developer/Xcode/app-store-connect-skills/skills/asc-marketing-manager/references/google-sheet-localizations.md):

- spreadsheet title pattern: `<App Name> strings 🌎🌍🌏`
- `Pages` tab first
- one version tab named from `ASC_SHEET_NAME`; if omitted, use the confirmed target version
- row 1: version label, `Name`, `Subtitle`, `Promotional Text`, `Description`, `What's new`, `Keywords`
- localization rows keyed by display labels such as `English 🇺🇸`
- `Reviewer Notes` below the localization table

After creating a blank sheet, do not apply ASC changes until the user fills and reviews the copy.

Expected sheet mapping:

- Default localization sheets use column `A` for language label, `B` for `Name`, `C` for `Subtitle`,
  `D` for `Promotional Text`, `E` for `Description`, `F` for `What's new`, and `G` for `Keywords`.
- Generic sheets may use named headers matching desired JSON fields:
  `locale`, `name`, `subtitle`, `promotionalText`, `description`, `keywords`,
  `supportUrl`, `marketingUrl`, `whatsNew`
- If a default localization sheet needs localized URL overrides, add optional columns named exactly
  `supportUrl` and `marketingUrl` after `Keywords`.

Use `ASC_SHEET_NAME` from the env file for sheet routing. If omitted, use the confirmed target
version. If the user's prompt does not specify which App Store version to edit or create, stop and
ask before reading sheets or running the ASC script.

## Script Commands

Dry run:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-metadata.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --desired /private/tmp/asc-desired-metadata.json \
  --version 2.3.0 \
  --ensure-version \
  --dry-run
```

Apply:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-metadata.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --desired /private/tmp/asc-desired-metadata.json \
  --version 2.3.0 \
  --ensure-version \
  --apply
```

Always run dry-run first. Only apply after the user explicitly asks.

Screenshot dry run:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --dry-run
```

Screenshot apply:

```zsh
node skills/asc-marketing-manager/scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --apply
```

Screenshot apply replaces each targeted ASC screenshot set. Always run dry-run first. Only apply
after the user explicitly asks.

Pricing audit:

```zsh
node skills/asc-pricing-manager/scripts/asc-audit-pricing.mjs \
  --env ~/.appstoreconnect/my-app-pricing.env \
  --out /private/tmp/asc-pricing-audit.json \
  --csv /private/tmp/asc-pricing-audit.csv
```

Pricing audit mode is read-only. It fetches the current app price schedule, manual prices,
automatic prices, included territories, and app price points, then writes reviewable JSON and CSV
artifacts. It must not schedule or apply price changes.

## Codex And Claude Usage

This repository does not provide plugin slash commands.

- Codex users should invoke the installed skills with `/skills` or `$asc-marketing-manager` and
  `$asc-pricing-manager`.
- Claude users should install the skill folders as custom skills, then invoke them by name or let
  them auto-trigger.

Repo-local Codex testing should use the `.agents/skills/*` symlinks instead of copied skill trees.

## Credential Rules

Never commit or print full credentials.

Required env values:

```zsh
ASC_KEY_ID=...
ASC_ISSUER_ID=...
ASC_KEY_PATH=/Users/you/.appstoreconnect/AuthKey_XXXXXXXXXX.p8
ASC_APP_ID=...
ASC_PLATFORM=...
ASC_COPYRIGHT=...
ASC_SHEET_ID=...
ASC_SHEET_NAME=...
```

Keep the target App Store version out of shared credential files. Provide it with `--version` or
`version.versionString`; screenshot sync uses `--version`. If the user did not specify the target
version in their prompt, ask for it. `ASC_PLATFORM` and `ASC_COPYRIGHT` are only needed when
creating a missing version.

Recommended permissions:

```zsh
chmod 700 ~/.appstoreconnect
chmod 600 ~/.appstoreconnect/*.env
chmod 600 ~/.appstoreconnect/*.p8
```

Least privilege ASC key role for metadata and screenshots: `Marketing`. Use a separate
pricing-capable key or env file for pricing audits; do not assume the Marketing key can read
pricing resources.

## Desired JSON Shape

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

The old top-level `locales` shape still works for `promotionalText` and `whatsNew`. Fallbacks copy
source-locale fields into ASC locale variants that do not have separate sheet rows.

## Safety Behavior

The scripts validate:

- required env values
- key file readability
- desired JSON shape
- locale fallback validity
- blank fields
- field character and byte limits
- support and marketing URL shape
- screenshot folder locale/display inference
- screenshot numeric ordering collisions
- screenshot file extensions and nonempty files

The metadata script normalizes trailing whitespace because ASC strips trailing whitespace on save.
The screenshot script uses ASC reservation, upload, and commit APIs, reorders uploaded screenshots,
and polls asset delivery state until processing succeeds or fails.

## Publishing Direction

This repo is a `skills.sh` collection and a manual custom-skill source for Codex and Claude.
Published installs should go through `skills.sh`. Repo-local Codex usage should rely on the
`.agents/skills/*` symlinks rather than any generated or mirrored skill trees.
