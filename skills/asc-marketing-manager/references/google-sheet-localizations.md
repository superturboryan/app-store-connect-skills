# Google Sheet Localizations

Use this reference when App Store Connect copy lives in Google Sheets, or when the user needs a new
spreadsheet for localized App Store metadata.

The bundled Node scripts do not call Google APIs. Sheet reads and creation are agent-side work
through the Google Sheets connector. Always write generated desired-state JSON to `/private/tmp`
before running an App Store Connect script.

## Find Or Create

1. Load the env file without printing secrets.
2. If `ASC_SHEET_ID` is set, read spreadsheet metadata for that ID.
3. If `ASC_SHEET_ID` is missing, empty, or points to a missing file, create a native Google Sheets
   spreadsheet through the connector.
4. Name a newly created spreadsheet after the app if known, using the pattern
   `<App Name> strings`.
5. Create or rename tabs so the spreadsheet has:
   - `Pages` as the first tab
   - one version tab named from `ASC_SHEET_NAME`; if omitted, use the confirmed target version
6. If the spreadsheet exists but the target version tab is missing, add only the missing version tab
   with the seed rows; do not duplicate unrelated tabs.
7. Tell the user the new spreadsheet ID and link, and tell them to add `ASC_SHEET_ID=<id>` and
   `ASC_SHEET_NAME=<version tab>` to their env file.

Prefer `ASC_SHEET_NAME` for sheet routing when the sheet tab is not exactly the target version.

Do not run the ASC apply step immediately after creating a blank sheet. The user must fill and
review the localization rows first.

## Connector Creation Outline

When creating the sheet with the Google Sheets connector:

1. Create a native Google Sheets file with title `<App Name> strings`.
2. Read spreadsheet metadata to get the default sheet ID.
3. Batch update the spreadsheet:
   - rename the default sheet to the version tab name
   - add a `Pages` sheet at index `0`
   - write the `Pages` seed rows from `assets/examples/pages-sheet-template.csv`
   - write the version-tab seed rows from `assets/examples/localization-sheet-template.csv`
   - replace the first cell with `<version>` or a display label such as `<version> watchOS`
   - freeze and format the first row of the version tab
   - format language labels in column `A`
   - format the `Reviewer Notes` label row
4. Re-read metadata and the populated range from the version tab to verify tab names, headers, seed
   rows, and any optional URL columns.

If the connector supports duplicating an existing localization template and the user points to one
explicitly, duplicating that sheet is acceptable. Otherwise create from the seed rows above so this
standalone skill does not depend on a private template.

## Default Localization Sheet Layout

New localization sheets should follow this shape:

- Spreadsheet title: `<App Name> strings`
- Tab 1: `Pages`
- Tab 2: version tab, usually the App Store version string such as `2.3.0`
- Version tab row 1:
  `2.3.0`, `Name`, `Subtitle`, `Promotional Text`, `Description`, `What's new`, `Keywords`
- Version tab row 2 and below: one language per row
- Blank row after localizations
- `Reviewer Notes` label in column `A`
- Review notes body in the next row, column `A`

The default version tab uses these columns:

| Column | Header | Desired JSON target |
| --- | --- | --- |
| A | version label / language label | locale lookup key |
| B | Name | `appInfo.locales[locale].name` |
| C | Subtitle | `appInfo.locales[locale].subtitle` |
| D | Promotional Text | `version.locales[locale].promotionalText` |
| E | Description | `version.locales[locale].description` |
| F | What's new | `version.locales[locale].whatsNew` |
| G | Keywords | `version.locales[locale].keywords` |

If an app needs localized support or marketing URLs in the sheet, add optional columns after
`Keywords` named exactly `supportUrl` and `marketingUrl`. They map directly to
`version.locales[locale].supportUrl` and `version.locales[locale].marketingUrl`.

## Seed Rows

Use these default display labels when creating a blank localization sheet. Adjust the set to match
the app's supported App Store Connect localizations.

| Display label | ASC locale |
| --- | --- |
| English 🇺🇸 | `en-US` |
| English (U.K.) 🇬🇧 | `en-GB` |
| Dutch 🇳🇱 | `nl-NL` |
| French 🇫🇷 | `fr-FR` |
| French (Canada) 🇨🇦 | `fr-CA` |
| German 🇩🇪 | `de-DE` |
| Italian 🇮🇹 | `it` |
| Japanese 🇯🇵 | `ja` |
| Korean 🇰🇷 | `ko` |
| Portuguese 🇧🇷 | `pt-BR` |
| Portuguese (Portugal) 🇵🇹 | `pt-PT` |
| Spanish (Mexico) 🇲🇽 | `es-MX` |
| Spanish (Spain) 🇪🇸 | `es-ES` |
| Russian 🇷🇺 | `ru` |
| Swedish 🇸🇪 | `sv` |
| Polish 🇵🇱 | `pl` |
| Arabic (SA) 🇸🇦 | `ar-SA` |
| Hebrew 🇮🇱 | `he` |
| Vietnamese 🇻🇳 | `vi` |
| Hindi 🇮🇳 | `hi` |
| Indonesian 🇮🇩 | `id` |
| Malay (MY) 🇲🇾 | `ms` |
| Turkish 🇹🇷 | `tr` |

When building desired JSON, use locale codes, not display labels. If the sheet contains a display
label that is not in the table above, infer the locale only when the label or user context is
unambiguous; otherwise ask the user before syncing.

## Pages Tab

The `Pages` tab is reference-only:

| Column | Purpose |
| --- | --- |
| A | storefront flag or region marker |
| B | App Store URL |

Do not read `Pages` into desired metadata JSON.

## Formatting

For newly created sheets, apply lightweight formatting:

- Freeze the first row on the version tab.
- Bold and center row 1.
- Wrap text in all copy columns.
- Bold and center language labels in column `A`.
- Make `Reviewer Notes` visually distinct.
- Resize columns so `Description` is wide and wrapped; leave `Keywords` readable.

The exact styling is less important than preserving the column order and tab structure.

## Desired JSON Extraction

The dependency-free mapper in `lib/sheet-mapper.mjs` converts a 2D sheet range into desired JSON.
Use it after reading values through the Google Sheets connector so mapping stays consistent across
agent runs.

1. Read metadata first and use the exact visible version tab name.
2. Read the bounded table range from `A1` through the last populated copy column.
3. Stop localization parsing at the first blank row or the `Reviewer Notes` row.
4. Map rows with nonblank copy fields into `appInfo.locales` and `version.locales`.
5. Map the row after `Reviewer Notes` into `review.notes` when it is nonblank.
6. Validate local field limits before network calls, especially `Keywords`, which ASC limits to
   100 UTF-8 bytes rather than 100 visible characters. Cyrillic, CJK, emoji, and accented text can
   exceed the byte limit sooner than expected; trim lower-value terms and rewrite the sheet.
7. Validate the resulting desired JSON with `parseDesiredMetadata` by running a dry run.

If the user manually edits the sheet after desired JSON or a dry run was created, discard the old
JSON, re-read the exact range from the sheet, rerun the mapper, regenerate `/private/tmp` JSON, and
rerun the dry run. The sheet is the source of truth.

When adding a new locale to an existing app version, prefer a version-locales-only JSON for the
first fallback apply only after a full desired-state dry-run/apply shows app-level `name` or
`subtitle` is blocked. New localization rows should populate `Name` and `Subtitle`; usually `Name`
matches the primary localization, while `Subtitle` is localized. App Info localizations are separate
ASC resources and may be blocked in states where version localizations can still be created or
updated. When that happens, report the app-info block explicitly and rerun a version-locales-only
dry-run/apply so allowed version metadata can still sync.

Do not put Apple device names in app `Name` or `Subtitle`; App Review can reject terms such as
`iPhone`, `iPad`, `Apple Watch`, `Apple TV`, `Apple Vision`, or `Vision Pro` in these fields. Use
generic terms like phone/watch or localized equivalents. Longer version metadata can still mention
platform requirements when appropriate.

For right-to-left locales such as Arabic and Hebrew, avoid starting subtitles, promotional text,
descriptions, headings, or bullet lines with Latin brand/platform terms such as `SoundCloud`,
`Apple Watch`, or `Quick Actions`. ASC text areas infer base direction from the first strong
character, so start each paragraph or bullet with localized RTL wording where possible.

Keep desired JSON in `/private/tmp` and do not commit unreleased marketing copy.
