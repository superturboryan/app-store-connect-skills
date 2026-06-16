import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applySyncPlan,
  assertEditableForChanges,
  buildAppInfoDiff,
  buildAppStoreVersionCreatePayload,
  buildAppStoreVersionPatchPayload,
  buildDiff,
  buildLocalizationCreatePayload,
  buildPatchPayload,
  buildReviewDetailDiff,
  buildReviewDetailPayload,
  buildSyncPlan,
  buildVersionAttributeDiff,
  buildVersionLocalizationDiff,
  expandFallbackLocales,
  loadAscState,
  normalizeAscText,
  parseDesiredMetadata,
  parseEnvFile,
  redactValue,
  redactSecrets,
  resolveVersionString,
  runSync,
  summarizeDiff,
  summarizeReviewDiff,
  unicodeLength,
  utf8ByteLength,
  validateDesiredMetadata,
  validateEnv,
  desiredMetadataFromSheetRows,
} from '../scripts/asc-sync-metadata.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

const fixturePath = (name) => path.join(fixturesDir, name);
const readFixture = (name) => fs.readFileSync(fixturePath(name), 'utf8');
const readJsonFixture = (name) => JSON.parse(readFixture(name));
const parseDesiredFixture = () => parseDesiredMetadata(readFixture('desired-valid.json'));
const parseDesiredObject = (desired) => parseDesiredMetadata(JSON.stringify(desired));

const validNestedDesired = () => ({
  appInfo: {
    locales: {
      'en-US': {
        name: 'Example App',
        subtitle: 'Music on your watch',
      },
    },
  },
  version: {
    versionString: '2.3.0',
    platform: 'IOS',
    copyright: '2026 Example',
    releaseType: 'AFTER_APPROVAL',
    usesIdfa: false,
    locales: {
      'en-US': {
        promotionalText: 'Listen from your wrist.',
        description: 'A focused SoundCloud player for watchOS.',
        keywords: 'soundcloud,watch,music',
        supportUrl: 'https://example.com/support',
        marketingUrl: 'https://example.com',
        whatsNew: '+ Bug fixes',
      },
    },
  },
  review: {
    contactFirstName: 'Ada',
    contactLastName: 'Lovelace',
    contactPhone: '+15555550123',
    contactEmail: 'ada@example.com',
    demoAccountRequired: true,
    demoAccountName: 'demo@example.com',
    demoAccountPassword: 'secret-password',
    notes: 'Use the demo account.',
  },
});

const matchingAscRoute = (apiPath, response) => ({
  matches: (candidatePath) => candidatePath === apiPath,
  response,
});

const ascRoutes = (routes) => {
  const calls = [];
  const request = async (method, apiPath) => {
    calls.push([method, apiPath]);
    const route = routes.find(({ matches }) => matches(apiPath));
    if (!route) throw new Error(`Unexpected call ${apiPath}`);
    return typeof route.response === 'function' ? route.response() : route.response;
  };

  return { calls, request };
};

test('given an env file without a version, when parsing and validating it, then credentials are valid', () => {
  // Given
  const envFileContents = `
ASC_KEY_ID=ABCD1234EF
ASC_ISSUER_ID=issuer-id
ASC_KEY_PATH=/tmp/AuthKey_ABCD1234EF.p8
ASC_APP_ID=1234567890
`;

  // When
  const env = parseEnvFile(envFileContents);
  const validateWithoutVersion = () => validateEnv(env, { checkKeyFile: false });
  const validateMissingRequiredValues = () => validateEnv({ ASC_KEY_ID: 'secret' }, { checkKeyFile: false });

  // Then
  assert.equal(env.ASC_KEY_ID, 'ABCD1234EF');
  assert.equal(redactValue(env.ASC_KEY_ID), 'AB…EF');
  assert.doesNotThrow(validateWithoutVersion);
  assert.throws(validateMissingRequiredValues, /Missing env values/);
});

test('given legacy desired metadata with locale fallbacks, when parsing and expanding version locales, then fallback locales copy source locale text', () => {
  // Given
  const desired = parseDesiredFixture();

  // When
  const expanded = expandFallbackLocales(desired.version);

  // Then
  assert.deepEqual(desired.appInfo.locales, {});
  assert.equal(expanded['en-GB'].promotionalText, desired.version.locales['en-US'].promotionalText);
  assert.equal(expanded['es-MX'].whatsNew, desired.version.locales['es-ES'].whatsNew);
  assert.deepEqual(Object.keys(expanded).sort(), ['en-GB', 'en-US', 'es-ES', 'es-MX', 'ja']);
});

test('given nested desired metadata, when parsing it, then app info, version, and review fields are preserved', () => {
  // Given
  const desiredJson = validNestedDesired();

  // When
  const desired = parseDesiredObject(desiredJson);

  // Then
  assert.equal(desired.appInfo.locales['en-US'].name, 'Example App');
  assert.equal(desired.version.versionString, '2.3.0');
  assert.equal(desired.review.demoAccountRequired, true);
});

test('given invalid desired metadata shapes, when validating them, then each shape fails with the expected error', () => {
  const scenarios = [
    {
      name: 'fallback to a missing source locale',
      given: {
        version: {
          locales: {
            'en-US': { promotionalText: 'Valid' },
          },
          fallbacks: {
            'en-GB': 'fr-FR',
          },
        },
      },
      then: /missing source locale/,
    },
    {
      name: 'blank locale fields',
      given: {
        version: {
          locales: {
            'en-US': { promotionalText: ' ' },
          },
        },
      },
      then: /blank/,
    },
    {
      name: 'mixed legacy and nested shape',
      given: {
        locales: {
          'en-US': { promotionalText: 'Valid', whatsNew: 'Valid' },
        },
        version: {},
      },
      then: /legacy top-level locales/,
    },
  ];

  for (const scenario of scenarios) {
    // Given
    const desired = scenario.given;

    // When
    const validate = () => validateDesiredMetadata(desired);

    // Then
    assert.throws(validate, scenario.then, scenario.name);
  }
});

test('given Unicode text, when counting characters and bytes, then character count and UTF-8 byte count are distinct', () => {
  // Given
  const japaneseText = '手首のウォッチ';
  const accentedCharacter = 'é';

  // When
  const characterCount = unicodeLength(japaneseText);
  const byteCount = utf8ByteLength(accentedCharacter);

  // Then
  assert.equal(characterCount, 7);
  assert.equal(byteCount, 2);
});

test('given desired metadata that exceeds field limits or has a bad URL, when validating it, then the matching limit error is raised', () => {
  const scenarios = [
    {
      name: 'name minimum length',
      given: { appInfo: { locales: { 'en-US': { name: 'x' } } } },
      then: /minimum characters/,
    },
    {
      name: 'subtitle maximum length',
      given: { appInfo: { locales: { 'en-US': { subtitle: 'x'.repeat(31) } } } },
      then: /31\/30/,
    },
    {
      name: 'promotional text maximum length',
      given: { version: { locales: { 'en-US': { promotionalText: 'x'.repeat(171) } } } },
      then: /171\/170/,
    },
    {
      name: 'description maximum length',
      given: { version: { locales: { 'en-US': { description: 'x'.repeat(4001) } } } },
      then: /4001\/4000/,
    },
    {
      name: 'keywords byte limit',
      given: { version: { locales: { 'en-US': { keywords: 'é'.repeat(51) } } } },
      then: /102\/100 UTF-8 bytes/,
    },
    {
      name: 'URL protocol requirement',
      given: { version: { locales: { 'en-US': { supportUrl: 'example.com/support' } } } },
      then: /valid URL/,
    },
    {
      name: 'URL web scheme requirement',
      given: { version: { locales: { 'en-US': { marketingUrl: 'ftp://example.com' } } } },
      then: /https URL/,
    },
    {
      name: 'app info control characters',
      given: { appInfo: { locales: { ja: { name: 'Example App:\nSoundCloudプレーヤー' } } } },
      then: /control characters/,
    },
    {
      name: 'Apple device name in subtitle',
      given: { appInfo: { locales: { hi: { subtitle: 'Apple Watch पर SoundCloud' } } } },
      then: /Apple device names/,
    },
    {
      name: 'Apple device name in app name',
      given: { appInfo: { locales: { 'en-US': { name: 'Player for iPhone' } } } },
      then: /Apple device names/,
    },
    {
      name: 'review notes byte limit',
      given: { review: { notes: 'é'.repeat(2001) } },
      then: /4002\/4000 UTF-8 bytes/,
    },
  ];

  for (const scenario of scenarios) {
    // Given
    const desired = scenario.given;

    // When
    const validate = () => validateDesiredMetadata(desired);

    // Then
    assert.throws(validate, scenario.then, scenario.name);
  }
});

test('given ASC text with trailing whitespace, when normalizing it, then trailing whitespace is removed', () => {
  // Given
  const textWithNewline = 'hello\n';
  const textWithMixedTrailingWhitespace = 'hello  \n\t';

  // When
  const normalizedNewlineText = normalizeAscText(textWithNewline);
  const normalizedMixedWhitespaceText = normalizeAscText(textWithMixedTrailingWhitespace);

  // Then
  assert.equal(normalizedNewlineText, 'hello');
  assert.equal(normalizedMixedWhitespaceText, 'hello');
});

test('given existing and desired version localizations, when building the diff, then unchanged, update, and create actions are reported', () => {
  // Given
  const desired = parseDesiredFixture();
  const desiredLocales = {
    ...expandFallbackLocales(desired.version),
    'fr-FR': {
      promotionalText: 'Ecoutez sur votre montre.',
      whatsNew: '+ Correctifs',
    },
  };
  const existingLocalizations = readJsonFixture('app-store-version-localizations.json').data;

  // When
  const diff = buildVersionLocalizationDiff(existingLocalizations, desiredLocales);
  const byLocale = Object.fromEntries(diff.map((change) => [change.locale, change]));

  // Then
  assert.equal(byLocale['en-US'].changed, false);
  assert.equal(byLocale['en-GB'].action, 'update');
  assert.deepEqual(Object.keys(byLocale['en-GB'].fields).sort(), ['promotionalText', 'whatsNew']);
  assert.equal(byLocale['fr-FR'].action, 'create');
  assert.match(summarizeDiff(diff), /fr-FR: CREATE/);
});

test('given callers use the legacy buildDiff alias, when building a localization diff, then version localization resources are returned', () => {
  // Given
  const existingLocalizations = readJsonFixture('app-store-version-localizations.json').data;
  const desiredLocales = {
    'en-US': {
      promotionalText: 'Different',
      whatsNew: '+ New',
    },
  };

  // When
  const diff = buildDiff(existingLocalizations, desiredLocales);

  // Then
  assert.equal(diff[0].resourceType, 'appStoreVersionLocalizations');
});

test('given app info localizations with one changed locale and one new locale, when building the diff, then update and create actions are returned', () => {
  // Given
  const existingLocalizations = [
    {
      type: 'appInfoLocalizations',
      id: 'app-info-en-us',
      attributes: {
        locale: 'en-US',
        name: 'Example App',
        subtitle: 'Old subtitle',
      },
    },
  ];
  const desiredLocales = {
    'en-US': {
      name: 'Example App',
      subtitle: 'Music on your watch',
    },
    'es-ES': {
      name: 'Example App',
      subtitle: 'Musica en tu reloj',
    },
  };

  // When
  const diff = buildAppInfoDiff(existingLocalizations, desiredLocales);

  // Then
  assert.equal(diff[0].action, 'update');
  assert.deepEqual(diff[0].fields, { subtitle: 'Music on your watch' });
  assert.equal(diff[1].action, 'create');
});

test('given localization update and create changes, when building payloads, then ASC JSON:API fields and relationships are included', () => {
  // Given
  const updateChange = {
    id: 'loc-123',
    resourceType: 'appStoreVersionLocalizations',
    fields: {
      promotionalText: 'New promo',
      whatsNew: '+ New notes',
    },
  };
  const createChange = {
    locale: 'fr-FR',
    resourceType: 'appStoreVersionLocalizations',
    createRelationshipName: 'appStoreVersion',
    createRelationshipType: 'appStoreVersions',
    desired: {
      promotionalText: 'Bonjour',
      whatsNew: '+ Notes',
    },
  };

  // When
  const patchPayload = buildPatchPayload(updateChange);
  const createPayload = buildLocalizationCreatePayload(createChange, 'version-123');

  // Then
  assert.deepEqual(patchPayload, {
    data: {
      type: 'appStoreVersionLocalizations',
      id: 'loc-123',
      attributes: {
        promotionalText: 'New promo',
        whatsNew: '+ New notes',
      },
    },
  });
  assert.equal(createPayload.data.attributes.locale, 'fr-FR');
  assert.equal(createPayload.data.relationships.appStoreVersion.data.id, 'version-123');
});

test('given a version create request without optional attributes, when building the payload, then default ASC values are used', () => {
  // Given
  const env = {
    ASC_APP_ID: '1234567890',
    ASC_COPYRIGHT: '2026 Example',
  };
  const desiredVersion = {
    versionString: '2.3.0',
  };

  // When
  const payload = buildAppStoreVersionCreatePayload(env, desiredVersion, '2.3.0');

  // Then
  assert.deepEqual(payload.data.attributes, {
    platform: 'IOS',
    versionString: '2.3.0',
    copyright: '2026 Example',
    releaseType: 'MANUAL',
    usesIdfa: false,
  });
});

test('given changed version fields include platform, when building the patch payload, then platform is omitted', () => {
  // Given
  const versionId = 'version-123';
  const changedFields = {
    platform: 'IOS',
    releaseType: 'AFTER_APPROVAL',
  };

  // When
  const payload = buildAppStoreVersionPatchPayload(versionId, changedFields);

  // Then
  assert.deepEqual(payload.data.attributes, {
    releaseType: 'AFTER_APPROVAL',
  });
});

test('given review detail changes include a password, when diffing and summarizing them, then summaries redact the password', () => {
  // Given
  const currentReviewDetail = {
    type: 'appStoreReviewDetails',
    id: 'review-123',
    attributes: {
      contactFirstName: 'Ada',
      demoAccountRequired: false,
      demoAccountPassword: 'old-secret',
    },
  };
  const desiredReviewDetail = {
    contactFirstName: 'Ada',
    demoAccountRequired: true,
    demoAccountPassword: 'new-secret',
    notes: 'Use sign in.',
  };

  // When
  const diff = buildReviewDetailDiff(currentReviewDetail, desiredReviewDetail);
  const summary = summarizeReviewDiff(diff);
  const payload = buildReviewDetailPayload(diff, 'version-123');

  // Then
  assert.equal(diff.action, 'update');
  assert.equal(diff.fields.demoAccountPassword, 'new-secret');
  assert.match(summary, /demoAccountPassword=<redacted>/);
  assert.doesNotMatch(summary, /new-secret/);
  assert.equal(payload.data.id, 'review-123');
  assert.equal(payload.data.attributes.demoAccountPassword, 'new-secret');
});

test('given args and desired metadata contain version values, when resolving the version string, then args win before desired', () => {
  // Given
  const desired = { version: { versionString: '2.0' } };
  const desiredWithoutVersion = { version: {} };

  // When
  const versionFromArgs = resolveVersionString({ version: '3.0' }, desired);
  const versionFromDesired = resolveVersionString({}, desired);
  const resolveMissingVersion = () => resolveVersionString({}, desiredWithoutVersion);

  // Then
  assert.equal(versionFromArgs, '3.0');
  assert.equal(versionFromDesired, '2.0');
  assert.throws(resolveMissingVersion, /Missing version string/);
});

test('given missing and existing ASC versions, when building version attribute diffs, then create and update changes are modeled', () => {
  // Given
  const desiredVersionForCreate = {
    versionString: '2.3.0',
    copyright: '2026 Example',
  };
  const existingVersion = {
    id: 'version-123',
    attributes: {
      versionString: '2.3.0',
      releaseType: 'MANUAL',
    },
  };
  const desiredVersionUpdate = {
    releaseType: 'AFTER_APPROVAL',
  };

  // When
  const createDiff = buildVersionAttributeDiff(null, desiredVersionForCreate, '2.3.0');
  const updateDiff = buildVersionAttributeDiff(existingVersion, desiredVersionUpdate, '2.3.0');

  // Then
  assert.equal(createDiff.action, 'create');
  assert.deepEqual(updateDiff.fields, { releaseType: 'AFTER_APPROVAL' });
});

test('given a noneditable released version with pending metadata changes, when asserting editability, then an error is raised', () => {
  // Given
  const releasedVersion = {
    id: 'version-123',
    attributes: {
      versionString: '2.3.0',
      appStoreState: 'READY_FOR_DISTRIBUTION',
    },
  };
  const pendingChanges = {
    appInfoChanges: [],
    versionLocalizationChanges: [
      {
        changed: true,
        fields: {
          description: 'Updated description',
        },
      },
    ],
    versionAttributeChange: { changed: false },
    reviewDetailChange: { changed: false },
  };

  // When
  const assertEditable = () => assertEditableForChanges(releasedVersion, pendingChanges);

  // Then
  assert.throws(assertEditable, /not editable/);
});

test('given a noneditable released version with only promotional text changes, when asserting editability, then it is allowed', () => {
  // Given
  const releasedVersion = {
    id: 'version-123',
    attributes: {
      versionString: '2.3.0',
      appVersionState: 'READY_FOR_SALE',
    },
  };
  const pendingChanges = {
    appInfoChanges: [],
    versionLocalizationChanges: [
      {
        changed: true,
        resourceType: 'appStoreVersionLocalizations',
        action: 'update',
        fields: {
          promotionalText: 'Updated promotional text',
        },
      },
    ],
    versionAttributeChange: { changed: false },
    reviewDetailChange: { changed: false },
  };

  // When
  const assertEditable = () => assertEditableForChanges(releasedVersion, pendingChanges);

  // Then
  assert.doesNotThrow(assertEditable);
});

test('given ASC API responses for app info, version, localizations, and review, when loading ASC state, then all state pieces are returned', async () => {
  // Given
  const { calls, request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [{ id: 'app-info-123', type: 'appInfos' }],
    }),
    matchingAscRoute('/appInfos/app-info-123/appInfoLocalizations?limit=200', {
      data: [
        {
          id: 'app-info-loc-en-us',
          attributes: { locale: 'en-US', name: 'Example App', subtitle: 'Music' },
        },
      ],
    }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', {
      data: [
        {
          id: 'version-123',
          attributes: {
            versionString: '1.2.3',
            appStoreState: 'PREPARE_FOR_SUBMISSION',
          },
        },
      ],
    }),
    matchingAscRoute('/appStoreVersions/version-123/appStoreVersionLocalizations?limit=200', () => (
      readJsonFixture('app-store-version-localizations.json')
    )),
    matchingAscRoute('/appStoreVersions/version-123/appStoreReviewDetail', {
      data: {
        id: 'review-123',
        attributes: {
          contactFirstName: 'Ada',
        },
      },
    }),
  ]);

  // When
  const state = await loadAscState(request, { ASC_APP_ID: '1234567890' }, { versionString: '1.2.3' });

  // Then
  assert.equal(state.appVersion.id, 'version-123');
  assert.equal(state.appInfo.id, 'app-info-123');
  assert.equal(state.localizations.length, 5);
  assert.equal(state.reviewDetail.id, 'review-123');
  assert.equal(calls.length, 5);
});

test('given ASC returns live and editable app info resources, when loading state, then editable app info is selected', async () => {
  // Given
  const { calls, request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [
        {
          id: 'app-info-live',
          type: 'appInfos',
          attributes: { appStoreState: 'READY_FOR_SALE', state: 'READY_FOR_DISTRIBUTION' },
        },
        {
          id: 'app-info-editable',
          type: 'appInfos',
          attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION', state: 'PREPARE_FOR_SUBMISSION' },
        },
      ],
    }),
    matchingAscRoute('/appInfos/app-info-editable/appInfoLocalizations?limit=200', {
      data: [
        {
          id: 'app-info-loc-en-us',
          attributes: { locale: 'en-US', name: 'Example App', subtitle: 'Music' },
        },
      ],
    }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', {
      data: [
        {
          id: 'version-123',
          attributes: {
            versionString: '1.2.3',
            appStoreState: 'PREPARE_FOR_SUBMISSION',
          },
        },
      ],
    }),
    matchingAscRoute('/appStoreVersions/version-123/appStoreVersionLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/appStoreVersions/version-123/appStoreReviewDetail', { data: null }),
  ]);

  // When
  const state = await loadAscState(request, { ASC_APP_ID: '1234567890' }, { versionString: '1.2.3' });

  // Then
  assert.equal(state.appInfo.id, 'app-info-editable');
  assert.deepEqual(calls.map(([method, apiPath]) => `${method} ${apiPath}`), [
    'GET /apps/1234567890/appInfos?limit=200',
    'GET /apps/1234567890/appStoreVersions?limit=200',
    'GET /appInfos/app-info-editable/appInfoLocalizations?limit=200',
    'GET /appStoreVersions/version-123/appStoreVersionLocalizations?limit=200',
    'GET /appStoreVersions/version-123/appStoreReviewDetail',
  ]);
});

test('given ASC has no matching version and missing versions are allowed, when loading ASC state, then version-specific state is empty', async () => {
  // Given
  const { request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [{ id: 'app-info-123', type: 'appInfos' }],
    }),
    matchingAscRoute('/appInfos/app-info-123/appInfoLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', {
      data: [
        {
          id: 'version-123',
          attributes: { versionString: '1.2.3' },
        },
      ],
    }),
  ]);

  // When
  const state = await loadAscState(request, { ASC_APP_ID: '1234567890' }, {
    versionString: '2.0.0',
    allowMissingVersion: true,
  });

  // Then
  assert.equal(state.appVersion, null);
  assert.deepEqual(state.versionLocalizations, []);
});

test('given ASC returns same version string on multiple platforms, when loading state, then the target platform is selected', async () => {
  // Given
  const { request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [{ id: 'app-info-123', type: 'appInfos' }],
    }),
    matchingAscRoute('/appInfos/app-info-123/appInfoLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', {
      data: [
        {
          id: 'version-macos',
          attributes: { versionString: '2.0.0', platform: 'MAC_OS' },
        },
        {
          id: 'version-ios',
          attributes: { versionString: '2.0.0', platform: 'IOS' },
        },
      ],
    }),
    matchingAscRoute('/appStoreVersions/version-ios/appStoreVersionLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/appStoreVersions/version-ios/appStoreReviewDetail', { data: null }),
  ]);

  // When
  const state = await loadAscState(request, { ASC_APP_ID: '1234567890', ASC_PLATFORM: 'IOS' }, {
    versionString: '2.0.0',
  });

  // Then
  assert.equal(state.appVersion.id, 'version-ios');
});

test('given ASC returns same version string on multiple platforms without a target platform, when missing versions are allowed, then lookup still fails as ambiguous', async () => {
  // Given
  const { request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [{ id: 'app-info-123', type: 'appInfos' }],
    }),
    matchingAscRoute('/appInfos/app-info-123/appInfoLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', {
      data: [
        {
          id: 'version-macos',
          attributes: { versionString: '2.0.0', platform: 'MAC_OS' },
        },
        {
          id: 'version-ios',
          attributes: { versionString: '2.0.0', platform: 'IOS' },
        },
      ],
    }),
  ]);

  // When
  const loadState = () => loadAscState(request, { ASC_APP_ID: '1234567890' }, {
    versionString: '2.0.0',
    allowMissingVersion: true,
  });

  // Then
  await assert.rejects(loadState, /ambiguous across platforms/);
});

test('given ASC paginates app versions, when loading state, then next links are followed', async () => {
  // Given
  const nextVersionsPath = 'https://api.appstoreconnect.apple.com/v1/apps/1234567890/appStoreVersions?cursor=next';
  const { request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [{ id: 'app-info-123', type: 'appInfos' }],
    }),
    matchingAscRoute('/appInfos/app-info-123/appInfoLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', {
      data: [{ id: 'old-version', attributes: { versionString: '1.0.0', platform: 'IOS' } }],
      links: { next: nextVersionsPath },
    }),
    matchingAscRoute(nextVersionsPath, {
      data: [{ id: 'version-200', attributes: { versionString: '2.0.0', platform: 'IOS' } }],
    }),
    matchingAscRoute('/appStoreVersions/version-200/appStoreVersionLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/appStoreVersions/version-200/appStoreReviewDetail', { data: null }),
  ]);

  // When
  const state = await loadAscState(request, { ASC_APP_ID: '1234567890', ASC_PLATFORM: 'IOS' }, {
    versionString: '2.0.0',
  });

  // Then
  assert.equal(state.appVersion.id, 'version-200');
});

test('given ensure-version dry-run and missing ASC version, when running the CLI seam, then all planned changes are summarized', async () => {
  // Given
  const desired = validNestedDesired();
  desired.version.versionString = '9.9.9';
  const outputs = [];
  const readFile = (filePath) => {
    if (filePath === '/tmp/test.env') {
      return `
ASC_KEY_ID=ABCD1234EF
ASC_ISSUER_ID=issuer-id
ASC_KEY_PATH=/tmp/AuthKey_ABCD1234EF.p8
ASC_APP_ID=1234567890
ASC_PLATFORM=IOS
ASC_COPYRIGHT=2026 Example
`;
    }
    if (filePath === '/tmp/desired.json') return JSON.stringify(desired);
    throw new Error(`Unexpected read ${filePath}`);
  };
  const { calls, request } = ascRoutes([
    matchingAscRoute('/apps/1234567890/appInfos?limit=200', {
      data: [{ id: 'app-info-123', type: 'appInfos' }],
    }),
    matchingAscRoute('/appInfos/app-info-123/appInfoLocalizations?limit=200', { data: [] }),
    matchingAscRoute('/apps/1234567890/appStoreVersions?limit=200', { data: [] }),
  ]);

  // When
  await runSync({
    argv: ['--env', '/tmp/test.env', '--desired', '/tmp/desired.json', '--ensure-version', '--dry-run'],
    readFile,
    ascRequest: request,
    checkKeyFile: false,
    logger: { log: (line) => outputs.push(line) },
  });

  // Then
  assert.deepEqual(calls.map(([method]) => method), ['GET', 'GET', 'GET']);
  assert.match(outputs.join('\n'), /ASC version 9\.9\.9: would create/);
  assert.match(outputs.join('\n'), /appInfo localizations:/);
  assert.match(outputs.join('\n'), /version localizations:/);
  assert.match(outputs.join('\n'), /review: CREATE/);
  assert.match(outputs.join('\n'), /appStoreVersions/);
  assert.match(outputs.join('\n'), /appStoreVersionLocalizations:en-US/);
});

test('given apply mode with changed metadata, when running the CLI seam, then writes are applied and verified from the sync plan', async () => {
  // Given
  const desired = validNestedDesired();
  const outputs = [];
  const calls = [];
  let patchCount = 0;
  const readFile = (filePath) => {
    if (filePath === '/tmp/test.env') {
      return `
ASC_KEY_ID=ABCD1234EF
ASC_ISSUER_ID=issuer-id
ASC_KEY_PATH=/tmp/AuthKey_ABCD1234EF.p8
ASC_APP_ID=1234567890
ASC_PLATFORM=IOS
`;
    }
    if (filePath === '/tmp/desired.json') return JSON.stringify(desired);
    throw new Error(`Unexpected read ${filePath}`);
  };
  const request = async (method, apiPath, body = null) => {
    calls.push({ method, apiPath, body });
    if (method === 'PATCH') {
      patchCount += 1;
      return { data: { id: body.data.id, type: body.data.type, attributes: body.data.attributes } };
    }

    const verifying = patchCount > 0;
    if (apiPath === '/apps/1234567890/appInfos?limit=200') {
      return { data: [{ id: 'app-info-123', type: 'appInfos' }] };
    }
    if (apiPath === '/appInfos/app-info-123/appInfoLocalizations?limit=200') {
      return {
        data: [
          {
            id: 'app-info-loc-en-us',
            type: 'appInfoLocalizations',
            attributes: verifying
              ? { locale: 'en-US', ...desired.appInfo.locales['en-US'] }
              : { locale: 'en-US', name: 'Example App', subtitle: 'Old subtitle' },
          },
        ],
      };
    }
    if (apiPath === '/apps/1234567890/appStoreVersions?limit=200') {
      return {
        data: [
          {
            id: 'version-123',
            type: 'appStoreVersions',
            attributes: verifying
              ? {
                versionString: '2.3.0',
                platform: 'IOS',
                appVersionState: 'PREPARE_FOR_SUBMISSION',
                copyright: desired.version.copyright,
                releaseType: desired.version.releaseType,
                usesIdfa: desired.version.usesIdfa,
              }
              : {
                versionString: '2.3.0',
                platform: 'IOS',
                appVersionState: 'PREPARE_FOR_SUBMISSION',
                copyright: '2025 Example',
                releaseType: 'MANUAL',
                usesIdfa: true,
              },
          },
        ],
      };
    }
    if (apiPath === '/appStoreVersions/version-123/appStoreVersionLocalizations?limit=200') {
      return {
        data: [
          {
            id: 'version-loc-en-us',
            type: 'appStoreVersionLocalizations',
            attributes: verifying
              ? { locale: 'en-US', ...desired.version.locales['en-US'] }
              : { locale: 'en-US', promotionalText: 'Old promo', description: 'Old description' },
          },
        ],
      };
    }
    if (apiPath === '/appStoreVersions/version-123/appStoreReviewDetail') {
      return {
        data: {
          id: 'review-123',
          type: 'appStoreReviewDetails',
          attributes: verifying ? desired.review : { contactFirstName: 'Old', notes: 'Old notes' },
        },
      };
    }
    throw new Error(`Unexpected call ${method} ${apiPath}`);
  };

  // When
  await runSync({
    argv: ['--env', '/tmp/test.env', '--desired', '/tmp/desired.json', '--apply'],
    readFile,
    ascRequest: request,
    checkKeyFile: false,
    logger: { log: (line) => outputs.push(line) },
  });

  // Then
  assert.deepEqual(calls.filter((call) => call.method === 'PATCH').map((call) => call.apiPath), [
    '/appStoreVersions/version-123',
    '/appInfoLocalizations/app-info-loc-en-us',
    '/appStoreVersionLocalizations/version-loc-en-us',
    '/appStoreReviewDetails/review-123',
  ]);
  assert.equal(calls.find((call) => call.apiPath === '/appStoreVersions/version-123').body.data.attributes.platform, undefined);
  assert.match(outputs.join('\n'), /Verified sync/);
});

test('given app info create auto-creates a version localization, when applying sync plan, then version localizations are re-fetched before write', async () => {
  // Given
  const desired = {
    appInfo: {
      locales: {
        tr: {
          name: 'Example App: SoundCloud Player',
          subtitle: 'SoundCloud saatinizde',
        },
      },
    },
    version: {
      versionString: '2.3.0',
      locales: {
        tr: {
          promotionalText: 'Promo TR',
          description: 'Description TR',
          whatsNew: '+ Notes TR',
          keywords: 'soundcloud,müzik',
        },
      },
    },
    review: null,
  };
  const state = {
    appInfo: { id: 'app-info-123', type: 'appInfos' },
    appInfoLocalizations: [],
    appVersion: {
      id: 'version-123',
      type: 'appStoreVersions',
      attributes: { versionString: '2.3.0', appVersionState: 'PREPARE_FOR_SUBMISSION' },
    },
    versionLocalizations: [],
    reviewDetail: null,
  };
  const plan = buildSyncPlan({
    state,
    desired,
    versionString: '2.3.0',
    desiredAppInfoLocales: desired.appInfo.locales,
    desiredVersionLocales: desired.version.locales,
  });
  const calls = [];
  const nextLocalizationsPath = 'https://api.appstoreconnect.apple.com/v1/appStoreVersions/version-123/appStoreVersionLocalizations?cursor=next';
  const request = async (method, apiPath, body = null) => {
    calls.push({ method, apiPath, body });
    if (method === 'POST' && apiPath === '/appInfoLocalizations') return { data: { id: 'app-info-loc-tr' } };
    if (method === 'GET' && apiPath === '/appStoreVersions/version-123/appStoreVersionLocalizations?limit=200') {
      return {
        data: [
          {
            id: 'version-loc-en-us',
            type: 'appStoreVersionLocalizations',
            attributes: { locale: 'en-US', promotionalText: 'Existing promo' },
          },
        ],
        links: { next: nextLocalizationsPath },
      };
    }
    if (method === 'GET' && apiPath === nextLocalizationsPath) {
      return {
        data: [
          {
            id: 'version-loc-tr',
            type: 'appStoreVersionLocalizations',
            attributes: {
              locale: 'tr',
              promotionalText: 'Old promo',
              description: 'Old description',
              whatsNew: '+ Old',
              keywords: 'old',
            },
          },
        ],
      };
    }
    if (method === 'PATCH' && apiPath === '/appStoreVersionLocalizations/version-loc-tr') return { data: { id: 'version-loc-tr' } };
    throw new Error(`Unexpected call ${method} ${apiPath}`);
  };

  // When
  const result = await applySyncPlan(request, plan);

  // Then
  assert.deepEqual(result.updatedAppInfo, ['tr:create']);
  assert.deepEqual(result.updatedVersionLocalizations, ['tr:update']);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.apiPath}`), [
    'POST /appInfoLocalizations',
    'GET /appStoreVersions/version-123/appStoreVersionLocalizations?limit=200',
    `GET ${nextLocalizationsPath}`,
    'PATCH /appStoreVersionLocalizations/version-loc-tr',
  ]);
});

test('given a secret appears in an ASC error body, when redacting secrets, then password values are removed', () => {
  // Given
  const errorBody = '{"errors":[{"detail":"demoAccountPassword new-secret rejected"}],"demoAccountPassword":"new-secret"}';

  // When
  const redacted = redactSecrets(errorBody);

  // Then
  assert.doesNotMatch(redacted, /new-secret/);
  assert.match(redacted, /<redacted>/);
});

test('given default layout sheet rows with URL columns and reviewer notes, when mapping to desired JSON, then localized fields are extracted', () => {
  // Given
  const rows = [
    ['2.3.0 watchOS', 'Name', 'Subtitle', 'Promotional Text', 'Description', "What's new", 'Keywords', 'supportUrl', 'marketingUrl'],
    ['English US', 'Example App', 'Music on your watch', 'Promo', 'Description', '+ Notes', 'music,watch', 'https://example.com/support', 'https://example.com'],
    ['Spanish ES', 'Example App', 'Musica en tu reloj', 'Promo ES', 'Descripcion', '+ Notas', 'musica,reloj', '', ''],
    [],
    ['Reviewer Notes'],
    ['Use the demo account.'],
  ];

  // When
  const desired = desiredMetadataFromSheetRows(rows);

  // Then
  assert.equal(desired.version.versionString, '2.3.0');
  assert.equal(desired.appInfo.locales['en-US'].subtitle, 'Music on your watch');
  assert.equal(desired.version.locales['en-US'].supportUrl, 'https://example.com/support');
  assert.equal(desired.version.locales['es-ES'].whatsNew, '+ Notas');
  assert.equal(desired.review.notes, 'Use the demo account.');
});

test('given display labels for new locales, when mapping rows, then app info and version locales use exact ASC locale codes', () => {
  // Given
  const rows = [
    ['2.3.0 watchOS', 'Name', 'Subtitle', 'Promotional Text', 'Description', "What's new", 'Keywords'],
    ['French (Canada) 🇨🇦', 'Example App', 'SoundCloud sur Apple Watch', 'Promo FR CA', 'Description FR CA', '+ Notes FR CA', 'soundcloud,musique'],
    ['Arabic (SA) 🇸🇦', 'Example App', 'SoundCloud على Apple Watch', 'Promo AR', 'Description AR', '+ Notes AR', 'soundcloud,موسيقى'],
    ['Vietnamese 🇻🇳', 'Example App', 'SoundCloud trên Apple Watch', 'Promo VI', 'Description VI', '+ Notes VI', 'soundcloud,nhạc'],
    ['Hindi 🇮🇳', 'Example App', 'Apple Watch पर SoundCloud', 'Promo HI', 'Description HI', '+ Notes HI', 'soundcloud,संगीत'],
    ['Indonesian 🇮🇩', 'Example App', 'SoundCloud di Apple Watch', 'Promo ID', 'Description ID', '+ Notes ID', 'soundcloud,musik'],
    ['Malay (MY) 🇲🇾', 'Example App', 'SoundCloud di Apple Watch', 'Promo MS', 'Description MS', '+ Notes MS', 'soundcloud,muzik'],
    ['Turkish 🇹🇷', 'Example App', 'SoundCloud saatinizde', 'Promo TR', 'Description TR', '+ Notes TR', 'soundcloud,müzik'],
  ];

  // When
  const desired = desiredMetadataFromSheetRows(rows);

  // Then
  assert.deepEqual(Object.keys(desired.appInfo.locales).sort(), ['ar-SA', 'fr-CA', 'hi', 'id', 'ms', 'tr', 'vi']);
  assert.equal(desired.appInfo.locales['fr-CA'].name, 'Example App');
  assert.equal(desired.appInfo.locales['fr-CA'].subtitle, 'SoundCloud sur Apple Watch');
  assert.equal(desired.version.locales['fr-CA'].promotionalText, 'Promo FR CA');
  assert.equal(desired.appInfo.locales['ar-SA'].subtitle, 'SoundCloud على Apple Watch');
  assert.equal(desired.appInfo.locales.vi.subtitle, 'SoundCloud trên Apple Watch');
  assert.equal(desired.appInfo.locales.hi.subtitle, 'Apple Watch पर SoundCloud');
  assert.equal(desired.appInfo.locales.id.subtitle, 'SoundCloud di Apple Watch');
  assert.equal(desired.appInfo.locales.ms.subtitle, 'SoundCloud di Apple Watch');
  assert.equal(desired.appInfo.locales.tr.subtitle, 'SoundCloud saatinizde');
});

test('given a sheet row with an unknown display label, when mapping to desired JSON, then locale inference fails clearly', () => {
  // Given
  const rows = [
    ['2.3.0', 'Name'],
    ['Unknown Language', 'Example App'],
  ];

  // When
  const mapRows = () => desiredMetadataFromSheetRows(rows);

  // Then
  assert.throws(mapRows, /Cannot infer ASC locale/);
});
