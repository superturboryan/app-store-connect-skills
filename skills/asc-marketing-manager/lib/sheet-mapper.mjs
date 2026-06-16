import {
  APP_INFO_FIELDS,
  REVIEW_FIELDS,
  VERSION_LOCALIZATION_FIELDS,
} from './asc-sync-core.mjs';

const DISPLAY_LABEL_LOCALES = new Map([
  ['english us', 'en-US'],
  ['english u.s.', 'en-US'],
  ['english uk', 'en-GB'],
  ['english u.k.', 'en-GB'],
  ['english', 'en-US'],
  ['dutch', 'nl-NL'],
  ['french canada', 'fr-CA'],
  ['french canadian', 'fr-CA'],
  ['french ca', 'fr-CA'],
  ['french (canada)', 'fr-CA'],
  ['french', 'fr-FR'],
  ['german', 'de-DE'],
  ['italian', 'it'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  ['portuguese brazil', 'pt-BR'],
  ['portuguese brasil', 'pt-BR'],
  ['portuguese br', 'pt-BR'],
  ['portuguese (brazil)', 'pt-BR'],
  ['portuguese portugal', 'pt-PT'],
  ['portuguese pt', 'pt-PT'],
  ['portuguese (portugal)', 'pt-PT'],
  ['portuguese', 'pt-BR'],
  ['spanish mexico', 'es-MX'],
  ['spanish mx', 'es-MX'],
  ['spanish (mexico)', 'es-MX'],
  ['spanish spain', 'es-ES'],
  ['spanish es', 'es-ES'],
  ['spanish (spain)', 'es-ES'],
  ['spanish', 'es-ES'],
  ['russian', 'ru'],
  ['swedish', 'sv'],
  ['polish', 'pl'],
  ['arabic saudi arabia', 'ar-SA'],
  ['arabic sa', 'ar-SA'],
  ['arabic (saudi arabia)', 'ar-SA'],
  ['arabic (sa)', 'ar-SA'],
  ['arabic', 'ar-SA'],
  ['hebrew', 'he'],
  ['vietnamese', 'vi'],
  ['hindi', 'hi'],
  ['indonesian', 'id'],
  ['malay my', 'ms'],
  ['malay malaysia', 'ms'],
  ['malay (my)', 'ms'],
  ['malay (malaysia)', 'ms'],
  ['malay', 'ms'],
  ['turkish turkey', 'tr'],
  ['turkish (turkey)', 'tr'],
  ['turkish', 'tr'],
]);

const DEFAULT_LAYOUT_HEADER_FIELDS = new Map([
  ['name', { section: 'appInfo', field: 'name' }],
  ['subtitle', { section: 'appInfo', field: 'subtitle' }],
  ['promotional text', { section: 'version', field: 'promotionalText' }],
  ['description', { section: 'version', field: 'description' }],
  ["what's new", { section: 'version', field: 'whatsNew' }],
  ['keywords', { section: 'version', field: 'keywords' }],
  ['supporturl', { section: 'version', field: 'supportUrl' }],
  ['marketingurl', { section: 'version', field: 'marketingUrl' }],
]);

export function desiredMetadataFromSheetRows(rows, { versionString = null, sheetName = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Sheet rows must be a nonempty 2D array.');
  const headers = rows[0].map(normalizeCell);
  const hasGenericLocaleHeader = headers.some((header) => normalizeHeader(header) === 'locale');

  return hasGenericLocaleHeader
    ? desiredFromGenericRows(rows, { versionString, sheetName })
    : desiredFromDefaultLayoutRows(rows, { versionString, sheetName });
}

function desiredFromDefaultLayoutRows(rows, { versionString, sheetName }) {
  const headers = rows[0].map((header) => normalizeHeader(header));
  const desired = emptyDesired(versionString ?? inferVersionString(rows[0][0]) ?? sheetName);
  const columnMappings = headers.map((header) => DEFAULT_LAYOUT_HEADER_FIELDS.get(header) ?? null);
  const reviewerNotesRowIndex = rows.findIndex((row) => normalizeHeader(row[0]) === 'reviewer notes');

  const lastLocalizationRow = reviewerNotesRowIndex === -1 ? rows.length : reviewerNotesRowIndex;
  for (const row of rows.slice(1, lastLocalizationRow)) {
    if (row.every((cell) => !normalizeCell(cell))) break;

    const label = normalizeCell(row[0]);
    if (!label) continue;
    const locale = localeFromDisplayLabel(label);

    for (let index = 1; index < columnMappings.length; index += 1) {
      const mapping = columnMappings[index];
      const value = normalizeCell(row[index]);
      if (!mapping || !value) continue;
      setDesiredField(desired, mapping.section, locale, mapping.field, value);
    }
  }

  applyReviewerNotes(desired, rows, reviewerNotesRowIndex);
  pruneEmptySections(desired);
  return desired;
}

function desiredFromGenericRows(rows, { versionString, sheetName }) {
  const headers = rows[0].map((header) => normalizeHeader(header));
  const localeIndex = headers.indexOf('locale');
  const desired = emptyDesired(versionString ?? sheetName);

  for (const row of rows.slice(1)) {
    if (row.every((cell) => !normalizeCell(cell))) continue;

    const locale = normalizeCell(row[localeIndex]);
    if (!locale) continue;

    for (let index = 0; index < headers.length; index += 1) {
      if (index === localeIndex) continue;
      const rawHeader = rows[0][index];
      const field = normalizeCell(rawHeader);
      const value = normalizeCell(row[index]);
      if (!field || !value) continue;

      if (APP_INFO_FIELDS.includes(field)) setDesiredField(desired, 'appInfo', locale, field, value);
      if (VERSION_LOCALIZATION_FIELDS.includes(field)) setDesiredField(desired, 'version', locale, field, value);
      if (REVIEW_FIELDS.includes(field)) desired.review = { ...(desired.review ?? {}), [field]: value };
    }
  }

  pruneEmptySections(desired);
  return desired;
}

function emptyDesired(versionString) {
  return {
    appInfo: { locales: {} },
    version: {
      ...(versionString ? { versionString } : {}),
      locales: {},
    },
    review: null,
  };
}

function setDesiredField(desired, section, locale, field, value) {
  desired[section].locales[locale] = {
    ...(desired[section].locales[locale] ?? {}),
    [field]: value,
  };
}

function applyReviewerNotes(desired, rows, reviewerNotesRowIndex) {
  if (reviewerNotesRowIndex === -1) return;
  const notes = normalizeCell(rows[reviewerNotesRowIndex + 1]?.[0]);
  if (!notes) return;
  desired.review = { ...(desired.review ?? {}), notes };
}

function pruneEmptySections(desired) {
  if (!Object.keys(desired.appInfo.locales).length) desired.appInfo = { locales: {} };
  if (!Object.keys(desired.version.locales).length) desired.version.locales = {};
}

function inferVersionString(value) {
  const text = normalizeCell(value);
  return text.split(/\s+/u)[0] || null;
}

function localeFromDisplayLabel(label) {
  if (/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(label)) return label;
  const normalized = normalizeHeader(label);
  const withoutEmoji = normalized.replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}/gu, '').trim();
  const exactLocale = DISPLAY_LABEL_LOCALES.get(withoutEmoji);
  if (exactLocale) return exactLocale;

  for (const [displayLabel, locale] of DISPLAY_LABEL_LOCALES.entries()) {
    if (withoutEmoji.startsWith(displayLabel)) return locale;
  }
  throw new Error(`Cannot infer ASC locale from sheet label: ${label}.`);
}

function normalizeHeader(value) {
  return normalizeCell(value).toLowerCase().replace(/\s+/gu, ' ');
}

function normalizeCell(value) {
  return String(value ?? '').trim();
}
