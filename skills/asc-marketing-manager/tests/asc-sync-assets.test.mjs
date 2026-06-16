import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyScreenshotSyncPlan,
  buildAppScreenshotCommitPayload,
  buildAppScreenshotCreatePayload,
  buildAppScreenshotSetCreatePayload,
  buildAppStoreVersionLocalizationCreatePayload,
  buildScreenshotSetOrderPayload,
  buildScreenshotSyncPlan,
  parseAssetArgs,
  runAssetSync,
  scanScreenshotAssets,
  summarizeScreenshotSyncPlan,
} from '../scripts/asc-sync-assets.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asc-assets-test-'));
}

function writeFixture(rootDir, relativePath, contents = 'image-bytes') {
  const absolutePath = path.join(rootDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

function editableVersion() {
  return {
    id: 'version-123',
    type: 'appStoreVersions',
    attributes: {
      versionString: '2.3.0',
      platform: 'IOS',
      appVersionState: 'PREPARE_FOR_SUBMISSION',
    },
  };
}

test('given mixed locale and display folders with numbered filenames, when scanning screenshots, then targets and order are inferred', () => {
  // Given
  const rootDir = makeTempDir();
  writeFixture(rootDir, 'en-US/APP_IPHONE_67/02-search.png');
  writeFixture(rootDir, 'APP_IPHONE_67/en-US/01-home.png');
  writeFixture(rootDir, 'Japanese 🇯🇵/iphone-6.7/03-now-playing.jpg');

  // When
  const manifest = scanScreenshotAssets(rootDir);
  const enUsTarget = manifest.targets.find((target) => target.locale === 'en-US');
  const jaTarget = manifest.targets.find((target) => target.locale === 'ja');

  // Then
  assert.equal(manifest.targets.length, 2);
  assert.equal(enUsTarget.displayType, 'APP_IPHONE_67');
  assert.deepEqual(enUsTarget.files.map((file) => file.fileName), ['01-home.png', '02-search.png']);
  assert.equal(jaTarget.displayType, 'APP_IPHONE_67');
  assert.equal(jaTarget.files[0].relativePath, 'Japanese 🇯🇵/iphone-6.7/03-now-playing.jpg');
});

test('given ambiguous or invalid screenshot folders, when scanning screenshots, then actionable errors are raised', () => {
  // Given
  const ambiguousRoot = makeTempDir();
  writeFixture(ambiguousRoot, 'en-US/fr-FR/APP_IPHONE_67/01-home.png');
  const duplicateRoot = makeTempDir();
  writeFixture(duplicateRoot, 'en-US/APP_IPHONE_67/01-home.png');
  writeFixture(duplicateRoot, 'en-US/APP_IPHONE_67/01-search.png');

  // When
  const scanAmbiguous = () => scanScreenshotAssets(ambiguousRoot);
  const scanDuplicate = () => scanScreenshotAssets(duplicateRoot);

  // Then
  assert.throws(scanAmbiguous, /multiple locale folders/);
  assert.throws(scanDuplicate, /duplicate numeric order 1/);
});

test('given screenshot CLI args, when parsing them, then replace-mode dry-run options are preserved', () => {
  // Given
  const argv = [
    '--env',
    '/tmp/test.env',
    '--assets',
    '/tmp/assets',
    '--version',
    '2.3.0',
    '--folder-shape',
    'display-first',
    '--wait-timeout-ms',
    '0',
    '--dry-run',
  ];

  // When
  const args = parseAssetArgs(argv);

  // Then
  assert.equal(args.env, '/tmp/test.env');
  assert.equal(args.assets, '/tmp/assets');
  assert.equal(args.version, '2.3.0');
  assert.equal(args.folderShape, 'display-first');
  assert.equal(args.replace, true);
  assert.equal(args.waitTimeoutMs, 0);
  assert.equal(args.mode, 'dry-run');
});

test('given screenshot resources, when building payloads, then ASC JSON API relationships are included', () => {
  // Given
  const file = {
    fileName: '01-home.png',
    size: 1234,
  };

  // When
  const localizationPayload = buildAppStoreVersionLocalizationCreatePayload('en-US', 'version-123');
  const setPayload = buildAppScreenshotSetCreatePayload('APP_IPHONE_67', 'loc-en-us');
  const screenshotPayload = buildAppScreenshotCreatePayload(file, 'set-123');
  const commitPayload = buildAppScreenshotCommitPayload('shot-123', 'abc123');
  const orderPayload = buildScreenshotSetOrderPayload(['shot-1', 'shot-2']);

  // Then
  assert.equal(localizationPayload.data.relationships.appStoreVersion.data.id, 'version-123');
  assert.equal(setPayload.data.attributes.screenshotDisplayType, 'APP_IPHONE_67');
  assert.equal(setPayload.data.relationships.appStoreVersionLocalization.data.id, 'loc-en-us');
  assert.equal(screenshotPayload.data.attributes.fileSize, 1234);
  assert.equal(screenshotPayload.data.relationships.appScreenshotSet.data.id, 'set-123');
  assert.equal(commitPayload.data.attributes.uploaded, true);
  assert.deepEqual(orderPayload.data.map((item) => item.id), ['shot-1', 'shot-2']);
});

test('given existing screenshot sets, when building a screenshot plan, then replacement summaries include existing counts', async () => {
  // Given
  const rootDir = makeTempDir();
  writeFixture(rootDir, 'en-US/APP_IPHONE_67/01-home.png');
  writeFixture(rootDir, 'en-US/APP_IPHONE_67/02-search.png');
  const manifest = scanScreenshotAssets(rootDir);
  const calls = [];
  const request = async (method, apiPath) => {
    calls.push(`${method} ${apiPath}`);
    if (apiPath === '/appStoreVersionLocalizations/loc-en-us/appScreenshotSets?limit=200') {
      return {
        data: [
          {
            id: 'set-old',
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
          },
        ],
      };
    }
    if (apiPath === '/appScreenshotSets/set-old/appScreenshots?limit=50') {
      return {
        data: [
          { id: 'old-1', type: 'appScreenshots' },
          { id: 'old-2', type: 'appScreenshots' },
          { id: 'old-3', type: 'appScreenshots' },
        ],
      };
    }
    throw new Error(`Unexpected call ${method} ${apiPath}`);
  };

  // When
  const plan = await buildScreenshotSyncPlan({
    request,
    state: {
      appVersion: editableVersion(),
      versionLocalizations: [
        {
          id: 'loc-en-us',
          type: 'appStoreVersionLocalizations',
          attributes: { locale: 'en-US' },
        },
      ],
    },
    manifest,
    versionString: '2.3.0',
  });
  const summary = summarizeScreenshotSyncPlan(plan).join('\n');

  // Then
  assert.equal(plan.targets[0].action, 'replace');
  assert.equal(plan.targets[0].existingScreenshotCount, 3);
  assert.match(summary, /REPLACE 3 existing with 2/);
  assert.deepEqual(calls, [
    'GET /appStoreVersionLocalizations/loc-en-us/appScreenshotSets?limit=200',
    'GET /appScreenshotSets/set-old/appScreenshots?limit=50',
  ]);
});

test('given an apply screenshot plan, when syncing assets, then upload reservation, commit, order, and verification occur', async () => {
  // Given
  const rootDir = makeTempDir();
  const filePath = writeFixture(rootDir, 'en-US/APP_IPHONE_67/01-home.png', 'abc123');
  const manifest = scanScreenshotAssets(rootDir);
  const planningRequest = async (method, apiPath) => {
    if (apiPath === '/appStoreVersionLocalizations/loc-en-us/appScreenshotSets?limit=200') {
      return {
        data: [
          {
            id: 'set-old',
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
          },
        ],
      };
    }
    if (apiPath === '/appScreenshotSets/set-old/appScreenshots?limit=50') {
      return { data: [{ id: 'old-1', type: 'appScreenshots' }] };
    }
    throw new Error(`Unexpected planning call ${method} ${apiPath}`);
  };
  const plan = await buildScreenshotSyncPlan({
    request: planningRequest,
    state: {
      appVersion: editableVersion(),
      versionLocalizations: [
        {
          id: 'loc-en-us',
          type: 'appStoreVersionLocalizations',
          attributes: { locale: 'en-US' },
        },
      ],
    },
    manifest,
    versionString: '2.3.0',
  });
  const calls = [];
  const uploads = [];
  const request = async (method, apiPath, body = null) => {
    calls.push({ method, apiPath, body });
    if (method === 'DELETE' && apiPath === '/appScreenshotSets/set-old') return {};
    if (method === 'POST' && apiPath === '/appScreenshotSets') return { data: { id: 'set-new', type: 'appScreenshotSets' } };
    if (method === 'POST' && apiPath === '/appScreenshots') {
      return {
        data: {
          id: 'shot-new',
          type: 'appScreenshots',
          attributes: {
            uploadOperations: [
              {
                method: 'PUT',
                url: 'https://upload.example/part-1',
                offset: 0,
                length: fs.statSync(filePath).size,
                requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
              },
            ],
          },
        },
      };
    }
    if (method === 'PATCH' && apiPath === '/appScreenshots/shot-new') return { data: { id: 'shot-new' } };
    if (method === 'PATCH' && apiPath === '/appScreenshotSets/set-new/relationships/appScreenshots') return {};
    if (method === 'GET' && apiPath === '/appScreenshots/shot-new') {
      return {
        data: {
          id: 'shot-new',
          attributes: {
            assetDeliveryState: { state: 'COMPLETE', errors: [] },
          },
        },
      };
    }
    throw new Error(`Unexpected apply call ${method} ${apiPath}`);
  };

  // When
  const result = await applyScreenshotSyncPlan(request, plan, {
    uploadRequest: async (operation, chunk) => uploads.push({ operation, chunk: chunk.toString('utf8') }),
    logger: { log: () => {} },
    waitTimeoutMs: 0,
    sleep: async () => {},
  });

  // Then
  assert.deepEqual(calls.map((call) => `${call.method} ${call.apiPath}`), [
    'DELETE /appScreenshotSets/set-old',
    'POST /appScreenshotSets',
    'POST /appScreenshots',
    'PATCH /appScreenshots/shot-new',
    'PATCH /appScreenshotSets/set-new/relationships/appScreenshots',
    'GET /appScreenshots/shot-new',
  ]);
  assert.equal(calls.find((call) => call.apiPath === '/appScreenshots').body.data.attributes.fileName, '01-home.png');
  assert.equal(calls.find((call) => call.apiPath === '/appScreenshots/shot-new').body.data.attributes.sourceFileChecksum, 'e99a18c428cb38d5f260853678922e03');
  assert.deepEqual(calls.find((call) => call.apiPath.endsWith('/relationships/appScreenshots')).body.data, [{ type: 'appScreenshots', id: 'shot-new' }]);
  assert.deepEqual(uploads, [{ operation: calls.find((call) => call.apiPath === '/appScreenshots') ? {
    method: 'PUT',
    url: 'https://upload.example/part-1',
    offset: 0,
    length: fs.statSync(filePath).size,
    requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
  } : null, chunk: 'abc123' }]);
  assert.equal(result.uploadedScreenshots.length, 1);
  assert.equal(result.assetSets[0].id, 'set-new');
});

test('given one missing locale with multiple display targets, when applying screenshots, then the localization is created once', async () => {
  // Given
  const rootDir = makeTempDir();
  writeFixture(rootDir, 'ja/APP_IPHONE_67/01-home.png', 'iphone-bytes');
  writeFixture(rootDir, 'ja/APP_IPAD_PRO_3GEN_129/01-home.png', 'ipad-bytes');
  const manifest = scanScreenshotAssets(rootDir);
  const plan = await buildScreenshotSyncPlan({
    request: async () => {
      throw new Error('No screenshot-set reads are expected for a missing localization.');
    },
    state: {
      appVersion: editableVersion(),
      versionLocalizations: [],
    },
    manifest,
    versionString: '2.3.0',
  });
  const calls = [];
  let screenshotCounter = 0;
  const request = async (method, apiPath, body = null) => {
    calls.push({ method, apiPath, body });
    if (method === 'POST' && apiPath === '/appStoreVersionLocalizations') return { data: { id: 'loc-ja' } };
    if (method === 'POST' && apiPath === '/appScreenshotSets') {
      return { data: { id: `set-${body.data.attributes.screenshotDisplayType}`, type: 'appScreenshotSets' } };
    }
    if (method === 'POST' && apiPath === '/appScreenshots') {
      screenshotCounter += 1;
      return {
        data: {
          id: `shot-${screenshotCounter}`,
          type: 'appScreenshots',
          attributes: {
            uploadOperations: [
              {
                method: 'PUT',
                url: `https://upload.example/${screenshotCounter}`,
                offset: 0,
                length: body.data.attributes.fileSize,
                requestHeaders: [],
              },
            ],
          },
        },
      };
    }
    if (method === 'PATCH' && apiPath.startsWith('/appScreenshots/')) return { data: { id: apiPath.split('/').at(-1) } };
    if (method === 'PATCH' && apiPath.includes('/relationships/appScreenshots')) return {};
    if (method === 'GET' && apiPath.startsWith('/appScreenshots/')) {
      return {
        data: {
          id: apiPath.split('/').at(-1),
          attributes: { assetDeliveryState: { state: 'COMPLETE', errors: [] } },
        },
      };
    }
    throw new Error(`Unexpected call ${method} ${apiPath}`);
  };

  // When
  await applyScreenshotSyncPlan(request, plan, {
    uploadRequest: async () => {},
    logger: { log: () => {} },
    waitTimeoutMs: 0,
    sleep: async () => {},
  });

  // Then
  assert.equal(plan.targets.filter((target) => target.createLocalization).length, 1);
  assert.equal(calls.filter((call) => call.apiPath === '/appStoreVersionLocalizations').length, 1);
  assert.deepEqual(calls.filter((call) => call.apiPath === '/appScreenshotSets').map((call) => call.body.data.relationships.appStoreVersionLocalization.data.id), ['loc-ja', 'loc-ja']);
});

test('given asset CLI dry-run, when running it, then ASC state is loaded and no writes are made', async () => {
  // Given
  const rootDir = makeTempDir();
  writeFixture(rootDir, 'en-US/APP_IPHONE_67/01-home.png');
  const outputs = [];
  const calls = [];
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
    throw new Error(`Unexpected read ${filePath}`);
  };
  const request = async (method, apiPath) => {
    calls.push(`${method} ${apiPath}`);
    if (apiPath === '/apps/1234567890/appStoreVersions?limit=200') {
      return {
        data: [
          {
            id: 'version-123',
            type: 'appStoreVersions',
            attributes: {
              versionString: '2.3.0',
              platform: 'IOS',
              appVersionState: 'PREPARE_FOR_SUBMISSION',
            },
          },
        ],
      };
    }
    if (apiPath === '/appStoreVersions/version-123/appStoreVersionLocalizations?limit=200') {
      return {
        data: [
          {
            id: 'loc-en-us',
            type: 'appStoreVersionLocalizations',
            attributes: { locale: 'en-US' },
          },
        ],
      };
    }
    if (apiPath === '/appStoreVersionLocalizations/loc-en-us/appScreenshotSets?limit=200') {
      return { data: [] };
    }
    throw new Error(`Unexpected dry-run call ${method} ${apiPath}`);
  };

  // When
  await runAssetSync({
    argv: ['--env', '/tmp/test.env', '--assets', rootDir, '--version', '2.3.0', '--dry-run'],
    readFile,
    ascRequest: request,
    checkKeyFile: false,
    logger: { log: (line) => outputs.push(line) },
  });

  // Then
  assert.deepEqual(calls, [
    'GET /apps/1234567890/appStoreVersions?limit=200',
    'GET /appStoreVersions/version-123/appStoreVersionLocalizations?limit=200',
    'GET /appStoreVersionLocalizations/loc-en-us/appScreenshotSets?limit=200',
  ]);
  assert.match(outputs.join('\n'), /screenshots version 2\.3\.0: 1 file across 1 set/);
  assert.match(outputs.join('\n'), /Dry-run complete/);
});
