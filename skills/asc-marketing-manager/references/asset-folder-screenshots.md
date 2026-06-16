# Screenshot Asset Folders

Use `scripts/asc-sync-assets.mjs` to dry-run and apply localized App Store screenshot assets from a
local folder. The script supports screenshots only. App previews use a similar ASC upload workflow
but are intentionally out of scope for this command.

## Commands

Dry run:

```zsh
node plugins/asc-marketing-manager/skills/asc-marketing-manager/scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --dry-run
```

Apply after a clean dry run:

```zsh
node plugins/asc-marketing-manager/skills/asc-marketing-manager/scripts/asc-sync-assets.mjs \
  --env ~/.appstoreconnect/my-app.env \
  --assets ./AppStoreScreenshots \
  --version 2.3.0 \
  --apply
```

Apply replaces each targeted ASC screenshot set. Do not apply until the user has reviewed the dry-run
summary.

## Folder Shape

Each screenshot path must contain exactly one ASC locale and exactly one screenshot display type.
The default `--folder-shape auto` accepts either order:

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

Use `--folder-shape locale-first` for `locale/display/files` only, or `--folder-shape display-first`
for `display/locale/files` only.

## Locale And Display Matching

Locale folders can use ASC locale codes such as `en-US`, `fr-CA`, `ja`, or common display labels such
as `Japanese`.

Display folders should use ASC screenshot display types, for example:

- `APP_IPHONE_67`
- `APP_IPHONE_65`
- `APP_IPAD_PRO_3GEN_129`
- `APP_WATCH_SERIES_10`
- `APP_APPLE_TV`
- `APP_APPLE_VISION_PRO`

Common aliases such as `iphone-6.7`, `watch-series-10`, `apple-tv`, and `vision-pro` are accepted,
but exact ASC values are preferred.

## Ordering

Leading filename numbers define screenshot order:

```text
01-home.png
02-search.png
10-settings.png
```

If filenames do not start with numbers, the script uses natural filename order. Duplicate leading
numbers in the same locale/display set fail validation.

## Ambiguity Rules

Stop and ask the user for clarification before applying when a dry run reports:

- missing locale folder
- missing display type folder
- multiple locale folders in one screenshot path
- multiple display type folders in one screenshot path
- duplicate numeric ordering
- unsupported file extensions

The safest fix is usually to rename folders into the explicit `locale/display/files` shape.
