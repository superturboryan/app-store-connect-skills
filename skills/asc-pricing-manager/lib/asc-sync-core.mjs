import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';
const REQUIRED_ENV_KEYS = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_PATH', 'ASC_APP_ID'];
const DEFAULT_PLATFORM = 'IOS';
const DEFAULT_RELEASE_TYPE = 'MANUAL';
const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

export const FIELD_REGISTRY = {
  appInfo: {
    name: { type: 'string', minChars: 2, maxChars: 30, noControlChars: true, noAppleDevices: true },
    subtitle: { type: 'string', maxChars: 30, noControlChars: true, noAppleDevices: true },
  },
  versionLocalization: {
    promotionalText: { type: 'string', maxChars: 170, editableAnytime: true },
    description: { type: 'string', maxChars: 4000 },
    keywords: { type: 'string', maxBytes: 100 },
    supportUrl: { type: 'string', url: true },
    marketingUrl: { type: 'string', url: true },
    whatsNew: { type: 'string', maxChars: 4000 },
  },
  versionAttribute: {
    versionString: { type: 'string' },
    copyright: { type: 'string' },
    releaseType: { type: 'string' },
    earliestReleaseDate: { type: 'string' },
    usesIdfa: { type: 'boolean' },
  },
  review: {
    contactFirstName: { type: 'string' },
    contactLastName: { type: 'string' },
    contactPhone: { type: 'string' },
    contactEmail: { type: 'string' },
    demoAccountRequired: { type: 'boolean' },
    demoAccountName: { type: 'string' },
    demoAccountPassword: { type: 'string', secret: true },
    notes: { type: 'string', maxBytes: 4000 },
  },
};

export const APP_INFO_FIELDS = Object.keys(FIELD_REGISTRY.appInfo);
export const VERSION_LOCALIZATION_FIELDS = Object.keys(FIELD_REGISTRY.versionLocalization);
export const VERSION_ATTRIBUTE_FIELDS = Object.keys(FIELD_REGISTRY.versionAttribute);
export const REVIEW_FIELDS = Object.keys(FIELD_REGISTRY.review);
export const FIELD_LIMITS = Object.fromEntries(Object.values(FIELD_REGISTRY)
  .flatMap((section) => Object.entries(section))
  .filter(([, field]) => field.minChars || field.maxChars || field.maxBytes)
  .map(([name, field]) => [name, {
    ...(field.minChars ? { minChars: field.minChars } : {}),
    ...(field.maxChars ? { maxChars: field.maxChars } : {}),
    ...(field.maxBytes ? { maxBytes: field.maxBytes } : {}),
  }]));

const URL_FIELDS = new Set(Object.values(FIELD_REGISTRY).flatMap((section) => (
  Object.entries(section).filter(([, field]) => field.url).map(([name]) => name)
)));
const SECRET_FIELDS = new Set(Object.values(FIELD_REGISTRY).flatMap((section) => (
  Object.entries(section).filter(([, field]) => field.secret).map(([name]) => name)
)));
const NO_CONTROL_CHAR_FIELDS = new Set(Object.values(FIELD_REGISTRY).flatMap((section) => (
  Object.entries(section).filter(([, field]) => field.noControlChars).map(([name]) => name)
)));
const NO_APPLE_DEVICE_FIELDS = new Set(Object.values(FIELD_REGISTRY).flatMap((section) => (
  Object.entries(section).filter(([, field]) => field.noAppleDevices).map(([name]) => name)
)));
const APPLE_DEVICE_PATTERN = /\b(?:iPhone|iPad|iPod|Apple\s+(?:Watch|TV|Vision)|AppleTV|Vision\s+Pro|MacBook|iMac|Mac\s+mini|Mac\s+Studio|Mac\s+Pro|HomePod|AirPods)\b/iu;
const PROMOTIONAL_TEXT_ONLY_FIELDS = new Set(Object.entries(FIELD_REGISTRY.versionLocalization)
  .filter(([, field]) => field.editableAnytime)
  .map(([name]) => name));

export function parseArgs(argv) {
  const args = { mode: null, ensureVersion: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      if (args.mode) throw new Error('Choose only one mode: --dry-run or --apply.');
      args.mode = 'dry-run';
    } else if (arg === '--apply') {
      if (args.mode) throw new Error('Choose only one mode: --dry-run or --apply.');
      args.mode = 'apply';
    } else if (arg === '--ensure-version') {
      args.ensureVersion = true;
    } else if (arg === '--env' || arg === '--desired' || arg === '--version') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      args[arg.slice(2)] = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.help) return args;
  if (!args.env) throw new Error('Missing --env <path>.');
  if (!args.desired) throw new Error('Missing --desired <path>.');
  if (!args.mode) throw new Error('Missing mode: use --dry-run or --apply.');
  return args;
}

export function parseEnvFile(contents) {
  const env = {};
  const lines = contents.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) throw new Error(`Invalid env line: ${redactValue(line)}`);
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

export function validateEnv(env, { checkKeyFile = true } = {}) {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing env values: ${missing.join(', ')}.`);

  if (checkKeyFile) {
    const keyPath = expandHome(env.ASC_KEY_PATH);
    if (!fs.existsSync(keyPath)) throw new Error(`ASC_KEY_PATH does not exist: ${redactPath(env.ASC_KEY_PATH)}.`);
    fs.accessSync(keyPath, fs.constants.R_OK);
  }

  return {
    ...env,
    ASC_KEY_PATH: expandHome(env.ASC_KEY_PATH),
  };
}

export function parseDesiredMetadata(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Desired metadata is not valid JSON: ${error.message}`);
  }

  return validateDesiredMetadata(parsed);
}

export function validateDesiredMetadata(desired) {
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    throw new Error('Desired metadata must be a JSON object.');
  }

  const normalized = normalizeDesiredShape(desired);
  validateLocaleSection('appInfo.locales', normalized.appInfo.locales, APP_INFO_FIELDS);
  validateLocaleSection('version.locales', normalized.version.locales, VERSION_LOCALIZATION_FIELDS);
  validateFallbacks(normalized.appInfo.locales, normalized.appInfo.fallbacks, 'appInfo.fallbacks');
  validateFallbacks(normalized.version.locales, normalized.version.fallbacks, 'version.fallbacks');
  validateVersionAttributes(normalized.version);
  validateReview(normalized.review);

  return normalized;
}

function normalizeDesiredShape(desired) {
  if (desired.locales) {
    if (!desired.version && !desired.appInfo && !desired.review) {
      return {
        appInfo: { locales: {}, fallbacks: {} },
        version: {
          locales: desired.locales,
          fallbacks: desired.fallbacks ?? {},
        },
        review: null,
      };
    }
    throw new Error('Use either legacy top-level locales or the nested appInfo/version/review shape, not both.');
  }

  const appInfo = desired.appInfo ?? {};
  const version = desired.version ?? {};
  return {
    appInfo: {
      locales: appInfo.locales ?? {},
      fallbacks: appInfo.fallbacks ?? desired.fallbacks ?? {},
    },
    version: {
      ...pickDefined(version, ['versionString', 'platform', 'copyright', 'releaseType', 'earliestReleaseDate', 'usesIdfa']),
      locales: version.locales ?? {},
      fallbacks: version.fallbacks ?? desired.fallbacks ?? {},
    },
    review: desired.review ?? null,
  };
}

function validateLocaleSection(sectionName, locales, allowedFields) {
  if (!locales || typeof locales !== 'object' || Array.isArray(locales)) {
    throw new Error(`${sectionName} must be an object.`);
  }

  for (const [locale, fields] of Object.entries(locales)) {
    validateLocaleCode(locale);
    validateFields(locale, fields, allowedFields);
  }
}

export function validateFields(locale, fields, allowedFields = VERSION_LOCALIZATION_FIELDS) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`Locale ${locale} must be an object.`);
  }

  const unknown = Object.keys(fields).filter((field) => !allowedFields.includes(field));
  if (unknown.length) throw new Error(`Locale ${locale} has unsupported fields: ${unknown.join(', ')}.`);
  if (!Object.keys(fields).length) throw new Error(`Locale ${locale} must include at least one supported field.`);

  for (const [field, value] of Object.entries(fields)) {
    validateTextField(`${locale} ${field}`, field, value);
  }
}

function validateVersionAttributes(version) {
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    throw new Error('version must be an object.');
  }

  if (version.platform !== undefined && typeof version.platform !== 'string') {
    throw new Error('version.platform must be a string when provided.');
  }
  if (version.versionString !== undefined && typeof version.versionString !== 'string') {
    throw new Error('version.versionString must be a string when provided.');
  }
  if (version.copyright !== undefined) validateTextField('version copyright', 'copyright', version.copyright);
  if (version.releaseType !== undefined) {
    if (!['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'].includes(version.releaseType)) {
      throw new Error('version.releaseType must be MANUAL, AFTER_APPROVAL, or SCHEDULED.');
    }
  }
  if (version.earliestReleaseDate !== undefined) {
    validateTextField('version earliestReleaseDate', 'earliestReleaseDate', version.earliestReleaseDate);
  }
  if (version.usesIdfa !== undefined && typeof version.usesIdfa !== 'boolean') {
    throw new Error('version.usesIdfa must be a boolean when provided.');
  }
}

function validateReview(review) {
  if (review === null) return;
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new Error('review must be an object when provided.');
  }

  const unknown = Object.keys(review).filter((field) => !REVIEW_FIELDS.includes(field));
  if (unknown.length) throw new Error(`review has unsupported fields: ${unknown.join(', ')}.`);

  for (const [field, value] of Object.entries(review)) {
    if (field === 'demoAccountRequired') {
      if (typeof value !== 'boolean') throw new Error('review.demoAccountRequired must be a boolean.');
      continue;
    }
    validateTextField(`review ${field}`, field, value);
  }
}

function validateFallbacks(locales, fallbacks, sectionName) {
  if (!fallbacks || typeof fallbacks !== 'object' || Array.isArray(fallbacks)) {
    throw new Error(`${sectionName} must be an object when provided.`);
  }
  for (const [targetLocale, sourceLocale] of Object.entries(fallbacks)) {
    validateLocaleCode(targetLocale);
    validateLocaleCode(sourceLocale);
    if (!locales[sourceLocale]) {
      throw new Error(`Fallback ${targetLocale} references missing source locale ${sourceLocale}.`);
    }
  }
}

function validateTextField(label, field, value) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = normalizeAscText(value);
  if (!normalized.trim()) throw new Error(`${label} is blank.`);

  if (URL_FIELDS.has(field)) validateUrl(label, normalized);
  if (NO_CONTROL_CHAR_FIELDS.has(field) && /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${label} must not contain control characters such as tabs or line breaks.`);
  }
  if (NO_APPLE_DEVICE_FIELDS.has(field) && APPLE_DEVICE_PATTERN.test(normalized)) {
    throw new Error(`${label} must not contain Apple device names; use generic terms like phone or watch.`);
  }

  const limits = FIELD_LIMITS[field];
  if (!limits) return;

  const charLength = unicodeLength(normalized);
  if (limits.minChars && charLength < limits.minChars) {
    throw new Error(`${label} is ${charLength}/${limits.minChars} minimum characters.`);
  }
  if (limits.maxChars && charLength > limits.maxChars) {
    throw new Error(`${label} is ${charLength}/${limits.maxChars} characters.`);
  }

  const byteLength = utf8ByteLength(normalized);
  if (limits.maxBytes && byteLength > limits.maxBytes) {
    throw new Error(`${label} is ${byteLength}/${limits.maxBytes} UTF-8 bytes.`);
  }
}

function validateUrl(label, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL with a protocol.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must be a valid https URL.`);
}

export function expandFallbackLocales(desiredOrSection) {
  const locales = desiredOrSection.locales ?? desiredOrSection.version?.locales ?? {};
  const fallbacks = desiredOrSection.fallbacks ?? desiredOrSection.version?.fallbacks ?? {};
  const expanded = { ...locales };

  for (const [targetLocale, sourceLocale] of Object.entries(fallbacks)) {
    if (expanded[targetLocale]) continue;
    expanded[targetLocale] = { ...locales[sourceLocale] };
  }

  return expanded;
}

export function normalizeAscText(value) {
  return String(value ?? '').replace(/\s+$/u, '');
}

export function normalizeFieldMap(fields, allowedFields) {
  const normalized = {};
  for (const field of allowedFields) {
    if (fields[field] === undefined) continue;
    normalized[field] = typeof fields[field] === 'string' ? normalizeAscText(fields[field]) : fields[field];
  }
  return normalized;
}

export function unicodeLength(value) {
  return [...String(value ?? '')].length;
}

export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

export function validateLocaleCode(locale) {
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
    throw new Error(`Invalid locale code: ${locale}.`);
  }
}

export function resolveVersionString(args, desired) {
  const versionString = args.version ?? desired.version.versionString;
  if (!versionString) {
    throw new Error('Missing version string. Provide --version <version> or version.versionString in desired JSON.');
  }
  return versionString;
}

export function generateJwt(env, { now = Math.floor(Date.now() / 1000) } = {}) {
  const header = { alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' };
  const payload = {
    iss: env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: fs.readFileSync(env.ASC_KEY_PATH, 'utf8'),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function createAscClient(env, requestFn = httpsRequest) {
  return async function ascRequest(method, apiPath, body = null) {
    const url = apiPath.startsWith('http') ? apiPath : `${ASC_BASE_URL}${apiPath}`;
    const token = generateJwt(env);
    return requestFn(method, url, token, body);
  };
}

export async function loadAscState(ascRequest, env, { versionString, allowMissingVersion = false } = {}) {
  const [appInfo, appVersion] = await Promise.all([
    loadAppInfoState(ascRequest, env),
    loadAppVersion(ascRequest, env, versionString, allowMissingVersion),
  ]);

  let versionLocalizations = [];
  let reviewDetail = null;
  if (appVersion) {
    versionLocalizations = await fetchAllPages(ascRequest, `/appStoreVersions/${encodeURIComponent(appVersion.id)}/appStoreVersionLocalizations?limit=200`);
    reviewDetail = await loadReviewDetail(ascRequest, appVersion.id);
  }

  return {
    appInfo: appInfo.appInfo,
    appInfoLocalizations: appInfo.localizations,
    appVersion,
    localizations: versionLocalizations,
    versionLocalizations,
    reviewDetail,
  };
}

async function loadAppInfoState(ascRequest, env) {
  const appInfos = await fetchAllPages(ascRequest, `/apps/${encodeURIComponent(env.ASC_APP_ID)}/appInfos?limit=200`);
  const appInfo = appInfos.find(isEditableAppInfo) ?? appInfos[0] ?? null;
  if (!appInfo) return { appInfo: null, localizations: [] };

  return {
    appInfo,
    localizations: await fetchAllPages(ascRequest, `/appInfos/${encodeURIComponent(appInfo.id)}/appInfoLocalizations?limit=200`),
  };
}

function isEditableAppInfo(appInfo) {
  const state = appInfo.attributes?.appStoreState ?? appInfo.attributes?.state;
  return EDITABLE_VERSION_STATES.has(state);
}

export async function loadAppVersion(ascRequest, env, versionString, allowMissingVersion) {
  if (!versionString) {
    throw new Error('Missing version string. Provide --version <version> or version.versionString in desired JSON.');
  }

  const versions = await fetchAllPages(ascRequest, `/apps/${encodeURIComponent(env.ASC_APP_ID)}/appStoreVersions?limit=200`);
  const matchingVersions = versions.filter((version) => version.attributes?.versionString === versionString);
  const targetPlatform = env.ASC_PLATFORM;
  const platformMatches = targetPlatform
    ? matchingVersions.filter((version) => version.attributes?.platform === targetPlatform)
    : matchingVersions;
  const appVersion = platformMatches.length === 1 ? platformMatches[0] : null;
  if (appVersion) return appVersion;
  if (targetPlatform && platformMatches.length > 1) {
    throw new Error(`ASC version ${versionString} is ambiguous for platform ${targetPlatform}.`);
  }
  if (!targetPlatform && matchingVersions.length > 1) {
    const seenPlatforms = [...new Set(matchingVersions.map((version) => version.attributes?.platform).filter(Boolean))];
    throw new Error(`ASC version ${versionString} is ambiguous across platforms: ${seenPlatforms.join(', ') || 'unknown'}. Set ASC_PLATFORM.`);
  }
  if (allowMissingVersion) return null;

  if (targetPlatform && matchingVersions.length && !platformMatches.length) {
    const seenPlatforms = [...new Set(matchingVersions.map((version) => version.attributes?.platform).filter(Boolean))];
    throw new Error(`Could not find ASC version ${versionString} for platform ${targetPlatform}. Saw platforms: ${seenPlatforms.join(', ') || 'none'}.`);
  }

  const seen = [...new Set(versions.map((version) => version.attributes?.versionString).filter(Boolean))];
  throw new Error(`Could not find ASC version ${versionString}. Saw: ${seen.join(', ') || 'none'}.`);
}

export async function fetchAllPages(ascRequest, apiPath) {
  const data = [];
  const seenPaths = new Set();
  let nextPath = apiPath;

  while (nextPath) {
    if (seenPaths.has(nextPath)) throw new Error(`ASC pagination loop detected at ${nextPath}.`);
    seenPaths.add(nextPath);

    const response = await ascRequest('GET', nextPath);
    data.push(...(response.data ?? []));
    nextPath = response.links?.next ?? null;
  }

  return data;
}

async function loadReviewDetail(ascRequest, appVersionId) {
  try {
    const response = await ascRequest('GET', `/appStoreVersions/${encodeURIComponent(appVersionId)}/appStoreReviewDetail`);
    return response.data ?? null;
  } catch (error) {
    if (String(error.message).includes('=> 404')) return null;
    throw error;
  }
}

export function buildAppInfoDiff(appInfoLocalizations, desiredLocales) {
  return buildLocalizationDiff({
    existingLocalizations: appInfoLocalizations,
    desiredLocales,
    fields: APP_INFO_FIELDS,
    resourceType: 'appInfoLocalizations',
    createRelationshipName: 'appInfo',
    createRelationshipType: 'appInfos',
  });
}

export function buildVersionLocalizationDiff(versionLocalizations, desiredLocales) {
  return buildLocalizationDiff({
    existingLocalizations: versionLocalizations,
    desiredLocales,
    fields: VERSION_LOCALIZATION_FIELDS,
    resourceType: 'appStoreVersionLocalizations',
    createRelationshipName: 'appStoreVersion',
    createRelationshipType: 'appStoreVersions',
  });
}

export function buildDiff(localizations, desiredLocales) {
  return buildVersionLocalizationDiff(localizations, desiredLocales);
}

function buildLocalizationDiff({ existingLocalizations, desiredLocales, fields, resourceType, createRelationshipName, createRelationshipType }) {
  const byLocale = new Map(existingLocalizations.map((localization) => [localization.attributes?.locale, localization]));

  return Object.entries(desiredLocales).map(([locale, rawDesired]) => {
    const localization = byLocale.get(locale);
    const desired = normalizeFieldMap(rawDesired, fields);
    const current = normalizeFieldMap(localization?.attributes ?? {}, fields);
    const changedFields = {};

    for (const [field, desiredValue] of Object.entries(desired)) {
      const currentValue = current[field] ?? '';
      if (currentValue !== desiredValue) changedFields[field] = desiredValue;
    }

    return {
      locale,
      id: localization?.id ?? null,
      resourceType,
      createRelationshipName,
      createRelationshipType,
      current,
      desired,
      fields: changedFields,
      action: localization ? (Object.keys(changedFields).length ? 'update' : 'unchanged') : 'create',
      changed: !localization || Object.keys(changedFields).length > 0,
    };
  });
}

export function buildVersionAttributeDiff(appVersion, desiredVersion, versionString) {
  const current = normalizeFieldMap(appVersion?.attributes ?? {}, VERSION_ATTRIBUTE_FIELDS);
  const desired = normalizeFieldMap({
    ...pickDefined(desiredVersion, VERSION_ATTRIBUTE_FIELDS),
    versionString,
  }, VERSION_ATTRIBUTE_FIELDS);
  const fields = {};

  for (const [field, desiredValue] of Object.entries(desired)) {
    if (current[field] !== desiredValue) fields[field] = desiredValue;
  }

  return {
    id: appVersion?.id ?? null,
    current,
    desired,
    fields,
    action: appVersion ? (Object.keys(fields).length ? 'update' : 'unchanged') : 'create',
    changed: !appVersion || Object.keys(fields).length > 0,
  };
}

export function buildReviewDetailDiff(reviewDetail, desiredReview) {
  if (!desiredReview) {
    return {
      id: reviewDetail?.id ?? null,
      current: {},
      desired: {},
      fields: {},
      action: 'unchanged',
      changed: false,
    };
  }

  const current = normalizeFieldMap(reviewDetail?.attributes ?? {}, REVIEW_FIELDS);
  const desired = normalizeFieldMap(desiredReview, REVIEW_FIELDS);
  const fields = {};

  for (const [field, desiredValue] of Object.entries(desired)) {
    if (current[field] !== desiredValue) fields[field] = desiredValue;
  }

  return {
    id: reviewDetail?.id ?? null,
    current,
    desired,
    fields,
    action: reviewDetail ? (Object.keys(fields).length ? 'update' : 'unchanged') : 'create',
    changed: !reviewDetail || Object.keys(fields).length > 0,
  };
}

export function buildPatchPayload(change) {
  return {
    data: {
      type: change.resourceType ?? 'appStoreVersionLocalizations',
      id: change.id,
      attributes: change.fields,
    },
  };
}

export function buildLocalizationCreatePayload(change, parentId) {
  return {
    data: {
      type: change.resourceType,
      attributes: {
        locale: change.locale,
        ...change.desired,
      },
      relationships: {
        [change.createRelationshipName]: {
          data: {
            type: change.createRelationshipType,
            id: parentId,
          },
        },
      },
    },
  };
}

export function buildAppStoreVersionCreatePayload(env, desiredVersion, versionString) {
  const copyright = desiredVersion.copyright ?? env.ASC_COPYRIGHT;
  if (!copyright) {
    throw new Error('Creating a new ASC version requires version.copyright or ASC_COPYRIGHT.');
  }

  const attributes = {
    platform: desiredVersion.platform ?? env.ASC_PLATFORM ?? DEFAULT_PLATFORM,
    versionString,
    copyright,
    releaseType: desiredVersion.releaseType ?? DEFAULT_RELEASE_TYPE,
    usesIdfa: desiredVersion.usesIdfa ?? false,
  };
  if (desiredVersion.earliestReleaseDate !== undefined) attributes.earliestReleaseDate = desiredVersion.earliestReleaseDate;

  return {
    data: {
      type: 'appStoreVersions',
      attributes,
      relationships: {
        app: {
          data: {
            type: 'apps',
            id: env.ASC_APP_ID,
          },
        },
      },
    },
  };
}

export function buildAppStoreVersionPatchPayload(appVersionId, fields) {
  const patchable = { ...fields };
  delete patchable.platform;

  return {
    data: {
      type: 'appStoreVersions',
      id: appVersionId,
      attributes: patchable,
    },
  };
}

export function buildReviewDetailPayload(change, appVersionId) {
  const payload = {
    data: {
      type: 'appStoreReviewDetails',
      attributes: change.action === 'create' ? change.desired : change.fields,
    },
  };

  if (change.action === 'update') payload.data.id = change.id;
  if (change.action === 'create') {
    payload.data.relationships = {
      appStoreVersion: {
        data: {
          type: 'appStoreVersions',
          id: appVersionId,
        },
      },
    };
  }

  return payload;
}

export async function ensureAppVersion(ascRequest, env, desiredVersion, versionString, { dryRun = false } = {}) {
  const appVersion = await loadAppVersion(ascRequest, env, versionString, true);
  if (appVersion || dryRun) return appVersion;

  const response = await ascRequest('POST', '/appStoreVersions', buildAppStoreVersionCreatePayload(env, desiredVersion, versionString));
  return response.data;
}

export async function applyLocalizationChanges(ascRequest, changes, parentId) {
  const updated = [];

  for (const change of changes) {
    if (!change.changed) continue;
    if (change.action === 'create') {
      await ascRequest('POST', `/${change.resourceType}`, buildLocalizationCreatePayload(change, parentId));
    } else {
      await ascRequest('PATCH', `/${change.resourceType}/${encodeURIComponent(change.id)}`, buildPatchPayload(change));
    }
    updated.push(`${change.locale}:${change.action}`);
  }

  return updated;
}

export async function applyChanges(ascRequest, changes) {
  const updated = [];

  for (const change of changes) {
    if (!change.changed) continue;
    if (change.action === 'create') {
      throw new Error('applyChanges requires a parentId for create actions; use applyLocalizationChanges.');
    }
    await ascRequest('PATCH', `/${change.resourceType ?? 'appStoreVersionLocalizations'}/${encodeURIComponent(change.id)}`, buildPatchPayload(change));
    updated.push(change.locale);
  }

  return updated;
}

export function verifyChanges(localizations, desiredLocales) {
  const diff = buildVersionLocalizationDiff(localizations, desiredLocales);
  return diff.filter((change) => change.changed).map((change) => change.locale);
}

export function summarizeDiff(changes, { title = null } = {}) {
  const rows = [];
  if (title) rows.push(`${title}:`);

  for (const change of changes) {
    const fieldNames = Object.keys(change.fields);
    const status = change.action === 'create' ? 'CREATE' : fieldNames.length ? `UPDATE ${fieldNames.join(', ')}` : 'unchanged';
    const limitSummary = summarizeFieldLimits(change.desired);
    rows.push(`${change.locale}: ${status}${limitSummary ? ` (${limitSummary})` : ''}`);
  }

  return rows.join('\n');
}

export function summarizeVersionDiff(change, versionString) {
  if (change.action === 'create') return `version ${versionString}: CREATE`;
  const fields = Object.keys(change.fields);
  return `version ${versionString}: ${fields.length ? `UPDATE ${fields.join(', ')}` : 'unchanged'}`;
}

export function summarizeReviewDiff(change) {
  const fields = Object.keys(change.fields).map((field) => (SECRET_FIELDS.has(field) ? `${field}=<redacted>` : field));
  if (change.action === 'create') {
    const desiredFields = Object.keys(change.desired).map((field) => (SECRET_FIELDS.has(field) ? `${field}=<redacted>` : field));
    return `review: CREATE ${desiredFields.join(', ') || 'no fields'}`;
  }
  return `review: ${fields.length ? `UPDATE ${fields.join(', ')}` : 'unchanged'}`;
}

function summarizeFieldLimits(fields) {
  const summaries = [];
  for (const [field, limits] of Object.entries(FIELD_LIMITS)) {
    if (fields[field] === undefined) continue;
    const value = normalizeAscText(fields[field]);
    if (limits.maxChars) summaries.push(`${field} ${unicodeLength(value)}/${limits.maxChars}`);
    if (limits.maxBytes) summaries.push(`${field} ${utf8ByteLength(value)}/${limits.maxBytes} bytes`);
  }
  return summaries.join(', ');
}

export function assertEditableForChanges(appVersion, changes) {
  if (!appVersion) return;
  const state = appVersion.attributes?.appVersionState ?? appVersion.attributes?.appStoreState ?? 'unknown';
  const requiresEditable = [
    ...changes.appInfoChanges,
    ...changes.versionLocalizationChanges,
    changes.versionAttributeChange,
    changes.reviewDetailChange,
  ].some((change) => changeRequiresEditableVersion(change));
  if (!requiresEditable) return;
  if (!EDITABLE_VERSION_STATES.has(state)) {
    throw new Error(`ASC version ${appVersion.attributes?.versionString ?? appVersion.id} is not editable: state=${state}.`);
  }
}

function changeRequiresEditableVersion(change) {
  if (!change?.changed) return false;
  if (change.resourceType !== 'appStoreVersionLocalizations') return true;
  if (change.action === 'create') return true;

  const changedFields = Object.keys(change.fields ?? {});
  return changedFields.some((field) => !PROMOTIONAL_TEXT_ONLY_FIELDS.has(field));
}

export function redactValue(value) {
  const text = String(value ?? '');
  if (text.length <= 4) return '<redacted>';
  return `${text.slice(0, 2)}…${text.slice(-2)}`;
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const field of SECRET_FIELDS) {
    text = text.replace(new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, 'gi'), `$1"<redacted>"`);
    text = text.replace(new RegExp(`(${field}\\s+)([^\\s",}]+)`, 'gi'), '$1<redacted>');
  }
  return text;
}

export function redactPath(value) {
  const text = String(value ?? '');
  return text.replace(/AuthKey_[A-Z0-9]+\.p8/g, 'AuthKey_<redacted>.p8');
}

function pickDefined(source, keys) {
  const picked = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

export function expandHome(value) {
  if (value === '~') return process.env.HOME;
  if (value?.startsWith('~/')) return path.join(process.env.HOME, value.slice(2));
  return value;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function httpsRequest(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(redactSecrets(`${method} ${url} => ${response.statusCode}\n${data.slice(0, 2000)}`)));
          return;
        }
        resolve(data ? JSON.parse(data) : {});
      });
    });

    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}
