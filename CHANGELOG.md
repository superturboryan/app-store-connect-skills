# Changelog

## 0.2.0

### Added

- Added support for transposed localization sheets where fields run down column `A` and locales run across columns.
- Added generic pricing benchmark analysis based on each territory's active price-tier position.
- Added read-only pricing recommendations for territories that appear below or above the dominant active tier.
- Added benchmark fields and suggested actions to pricing audit CSV output.

### Changed

- Updated pricing audit outlier detection to use observed App Store price ladders instead of fixed `3.99` / `0.99` bands.
- Updated keyword validation from a 100-byte limit to a 100-character limit to match verified App Store Connect behavior.
- Updated Google Sheets localization guidance for transposed sheet ranges and localized URL columns.

### Fixed

- Metadata dry runs now detect sibling ASC locales that would otherwise be skipped when only one locale variant is present in desired JSON.
- Added explicit fallback guidance for shared-language locales such as `es-ES` / `es-MX`, `pt-BR` / `pt-PT`, and `en-US` / `en-GB`.
- Ensured ASC HTTP responses are decoded as UTF-8 text before JSON parsing.

## 0.1.0

- Initial published App Store Connect skills collection.
- Included `asc-marketing-manager` for localized metadata, App Review fields, version creation, and screenshot sync workflows.
- Included `asc-pricing-manager` for read-only regional pricing audits.
