# Desired Metadata JSON

The ASC sync script accepts desired-state JSON with App Store Connect text metadata.

## Current Shape

```json
{
  "appInfo": {
    "locales": {
      "en-US": {
        "name": "Example App",
        "subtitle": "Music on your watch"
      }
    },
    "fallbacks": {
      "en-GB": "en-US"
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
        "promotionalText": "Short promotional text.",
        "description": "Long App Store description.",
        "keywords": "music,watch,streaming",
        "supportUrl": "https://example.com/support",
        "marketingUrl": "https://example.com",
        "whatsNew": "+ Release note one\n+ Release note two"
      }
    },
    "fallbacks": {
      "en-GB": "en-US"
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

## Fields

- `appInfo.locales`: optional object keyed by ASC locale code for `name` and `subtitle`. These
  are App Info localization fields, not version-localization fields. ASC may reject them in states
  where version metadata is still editable; if that happens, omit `appInfo.locales` and retry a
  version-locales-only dry-run/apply.
- `version.locales`: optional object keyed by ASC locale code for `promotionalText`, `description`, `keywords`, `supportUrl`, `marketingUrl`, and `whatsNew`.
- `version.versionString`: optional only when `--version` is provided. Required with
  `--ensure-version` when creating a missing version unless `--version` is provided.
- `version.platform`: optional for existing versions, but recommended when the same version string
  exists on multiple platforms; defaults to `ASC_PLATFORM` or `IOS` when creating a version.
- `version.copyright`: required for `--ensure-version --apply` unless `ASC_COPYRIGHT` is set.
- `version.releaseType`: optional; one of `MANUAL`, `AFTER_APPROVAL`, or `SCHEDULED`; defaults to `MANUAL` when creating a version.
- `version.earliestReleaseDate`: optional ISO date-time string for scheduled release.
- `version.usesIdfa`: optional boolean; defaults to `false` when creating a version.
- `review`: optional App Review information. Do not commit desired JSON containing real demo passwords.
- `fallbacks`, `appInfo.fallbacks`, and `version.fallbacks`: optional mappings from target ASC locale to a source locale.

The old top-level shape remains valid for backward compatibility:

```json
{
  "locales": {
    "en-US": {
      "promotionalText": "Short promotional text.",
      "whatsNew": "+ Release note"
    }
  },
  "fallbacks": {
    "en-GB": "en-US"
  }
}
```

Legacy `locales` are treated as `version.locales`.

## Limits

- `name`: 2-30 Unicode code points.
- `subtitle`: max 30 Unicode code points.
- `promotionalText`: max 170 Unicode code points.
- `description`: max 4000 Unicode code points.
- `whatsNew`: max 4000 Unicode code points.
- `keywords`: max 100 UTF-8 bytes. Count bytes, not visible characters; non-ASCII keywords can
  exceed the limit quickly.
- `review.notes`: max 4000 UTF-8 bytes.
- `supportUrl` and `marketingUrl`: valid HTTPS URLs.

All provided string fields must be nonblank after trailing whitespace normalization.

## Locale Rules

Use exact locale codes returned by App Store Connect, for example:

- `en-US`
- `en-GB`
- `nl-NL`
- `fr-FR`
- `de-DE`
- `ja`
- `ko`
- `es-ES`
- `es-MX`
- `pt-BR`
- `pt-PT`

The metadata script can create missing App Info and App Store Version Localization rows for desired
locales. It does not upload assets. Use `scripts/asc-sync-assets.mjs` and
`references/asset-folder-screenshots.md` for screenshot uploads.
