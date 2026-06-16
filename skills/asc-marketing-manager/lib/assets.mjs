import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import {
  createAscClient,
  expandHome,
  fetchAllPages,
  loadAppVersion,
  parseEnvFile,
  validateEnv,
  validateLocaleCode,
} from './asc-sync-core.mjs';

const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

const MAX_SCREENSHOTS_PER_SET = 10;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_INTERVAL_MS = 5_000;
const DEFAULT_FOLDER_SHAPE = 'auto';
const FOLDER_SHAPES = new Set(['auto', 'locale-first', 'display-first']);

export const SUPPORTED_SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
export const SCREENSHOT_DISPLAY_TYPES = new Set([
  'APP_IPHONE_67',
  'APP_IPHONE_61',
  'APP_IPHONE_65',
  'APP_IPHONE_58',
  'APP_IPHONE_55',
  'APP_IPHONE_47',
  'APP_IPHONE_40',
  'APP_IPHONE_35',
  'APP_IPAD_PRO_3GEN_129',
  'APP_IPAD_PRO_3GEN_11',
  'APP_IPAD_PRO_129',
  'APP_IPAD_105',
  'APP_IPAD_97',
  'APP_DESKTOP',
  'APP_WATCH_ULTRA',
  'APP_WATCH_SERIES_10',
  'APP_WATCH_SERIES_7',
  'APP_WATCH_SERIES_4',
  'APP_WATCH_SERIES_3',
  'APP_APPLE_TV',
  'APP_APPLE_VISION_PRO',
  'IMESSAGE_APP_IPHONE_67',
  'IMESSAGE_APP_IPHONE_61',
  'IMESSAGE_APP_IPHONE_65',
  'IMESSAGE_APP_IPHONE_58',
  'IMESSAGE_APP_IPHONE_55',
  'IMESSAGE_APP_IPHONE_47',
  'IMESSAGE_APP_IPHONE_40',
  'IMESSAGE_APP_IPAD_PRO_3GEN_129',
  'IMESSAGE_APP_IPAD_PRO_3GEN_11',
  'IMESSAGE_APP_IPAD_PRO_129',
  'IMESSAGE_APP_IPAD_105',
  'IMESSAGE_APP_IPAD_97',
]);

const DISPLAY_ALIASES = new Map([
  ['IPHONE_67', 'APP_IPHONE_67'],
  ['IPHONE_6_7', 'APP_IPHONE_67'],
  ['IPHONE_61', 'APP_IPHONE_61'],
  ['IPHONE_6_1', 'APP_IPHONE_61'],
  ['IPHONE_65', 'APP_IPHONE_65'],
  ['IPHONE_6_5', 'APP_IPHONE_65'],
  ['IPHONE_58', 'APP_IPHONE_58'],
  ['IPHONE_5_8', 'APP_IPHONE_58'],
  ['IPHONE_55', 'APP_IPHONE_55'],
  ['IPHONE_5_5', 'APP_IPHONE_55'],
  ['IPHONE_47', 'APP_IPHONE_47'],
  ['IPHONE_4_7', 'APP_IPHONE_47'],
  ['IPHONE_40', 'APP_IPHONE_40'],
  ['IPHONE_4_0', 'APP_IPHONE_40'],
  ['IPHONE_35', 'APP_IPHONE_35'],
  ['IPHONE_3_5', 'APP_IPHONE_35'],
  ['IPAD_PRO_3GEN_129', 'APP_IPAD_PRO_3GEN_129'],
  ['IPAD_PRO_3GEN_12_9', 'APP_IPAD_PRO_3GEN_129'],
  ['IPAD_PRO_3GEN_11', 'APP_IPAD_PRO_3GEN_11'],
  ['IPAD_PRO_129', 'APP_IPAD_PRO_129'],
  ['IPAD_PRO_12_9', 'APP_IPAD_PRO_129'],
  ['IPAD_105', 'APP_IPAD_105'],
  ['IPAD_10_5', 'APP_IPAD_105'],
  ['IPAD_97', 'APP_IPAD_97'],
  ['IPAD_9_7', 'APP_IPAD_97'],
  ['DESKTOP', 'APP_DESKTOP'],
  ['MAC', 'APP_DESKTOP'],
  ['MACOS', 'APP_DESKTOP'],
  ['WATCH_ULTRA', 'APP_WATCH_ULTRA'],
  ['WATCH_SERIES_10', 'APP_WATCH_SERIES_10'],
  ['WATCH_SERIES_7', 'APP_WATCH_SERIES_7'],
  ['WATCH_SERIES_4', 'APP_WATCH_SERIES_4'],
  ['WATCH_SERIES_3', 'APP_WATCH_SERIES_3'],
  ['APPLE_TV', 'APP_APPLE_TV'],
  ['TVOS', 'APP_APPLE_TV'],
  ['VISION_PRO', 'APP_APPLE_VISION_PRO'],
  ['APPLE_VISION_PRO', 'APP_APPLE_VISION_PRO'],
]);

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
  ['french', 'fr-FR'],
  ['german', 'de-DE'],
  ['italian', 'it'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  ['portuguese brazil', 'pt-BR'],
  ['portuguese brasil', 'pt-BR'],
  ['portuguese br', 'pt-BR'],
  ['portuguese portugal', 'pt-PT'],
  ['portuguese pt', 'pt-PT'],
  ['portuguese', 'pt-BR'],
  ['spanish mexico', 'es-MX'],
  ['spanish mx', 'es-MX'],
  ['spanish spain', 'es-ES'],
  ['spanish es', 'es-ES'],
  ['spanish', 'es-ES'],
  ['russian', 'ru'],
  ['swedish', 'sv'],
  ['polish', 'pl'],
  ['arabic saudi arabia', 'ar-SA'],
  ['arabic sa', 'ar-SA'],
  ['arabic', 'ar-SA'],
  ['hebrew', 'he'],
  ['vietnamese', 'vi'],
  ['hindi', 'hi'],
  ['indonesian', 'id'],
  ['malay my', 'ms'],
  ['malay malaysia', 'ms'],
  ['malay', 'ms'],
  ['turkish turkey', 'tr'],
  ['turkish', 'tr'],
]);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function parseAssetArgs(argv) {
  const args = {
    mode: null,
    folderShape: DEFAULT_FOLDER_SHAPE,
    replace: true,
    waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      if (args.mode) throw new Error('Choose only one mode: --dry-run or --apply.');
      args.mode = 'dry-run';
    } else if (arg === '--apply') {
      if (args.mode) throw new Error('Choose only one mode: --dry-run or --apply.');
      args.mode = 'apply';
    } else if (arg === '--replace') {
      args.replace = true;
    } else if (arg === '--env' || arg === '--assets' || arg === '--version' || arg === '--folder-shape' || arg === '--locale-order' || arg === '--wait-timeout-ms') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--folder-shape' || arg === '--locale-order') {
        if (!FOLDER_SHAPES.has(value)) throw new Error(`${arg} must be one of: ${[...FOLDER_SHAPES].join(', ')}.`);
        args.folderShape = value;
      } else if (arg === '--wait-timeout-ms') {
        const waitTimeoutMs = Number(value);
        if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 0) throw new Error('--wait-timeout-ms must be a nonnegative integer.');
        args.waitTimeoutMs = waitTimeoutMs;
      } else {
        args[arg.slice(2)] = value;
      }
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.help) return args;
  if (!args.env) throw new Error('Missing --env <path>.');
  if (!args.assets) throw new Error('Missing --assets <dir>.');
  if (!args.mode) throw new Error('Missing mode: use --dry-run or --apply.');
  return args;
}

export function scanScreenshotAssets(rootDir, { folderShape = DEFAULT_FOLDER_SHAPE } = {}) {
  if (!FOLDER_SHAPES.has(folderShape)) {
    throw new Error(`folderShape must be one of: ${[...FOLDER_SHAPES].join(', ')}.`);
  }

  const absoluteRoot = path.resolve(expandHome(rootDir));
  const rootStat = safeStat(absoluteRoot);
  if (!rootStat?.isDirectory()) throw new Error(`Screenshot asset root is not a readable directory: ${rootDir}.`);

  const files = [];
  const issues = [];

  for (const absolutePath of walkFiles(absoluteRoot)) {
    const relativePath = toPosixPath(path.relative(absoluteRoot, absolutePath));
    const fileName = path.basename(absolutePath);
    if (fileName.startsWith('.')) continue;

    const extension = path.extname(fileName).toLowerCase();
    if (!SUPPORTED_SCREENSHOT_EXTENSIONS.has(extension)) {
      issues.push(`${relativePath}: unsupported screenshot extension ${extension || '<none>'}`);
      continue;
    }

    const target = inferTargetFromPath(relativePath, { folderShape });
    if (target.error) {
      issues.push(`${relativePath}: ${target.error}`);
      continue;
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) continue;
    if (stat.size <= 0) {
      issues.push(`${relativePath}: screenshot file is empty`);
      continue;
    }

    files.push({
      ...target,
      absolutePath,
      relativePath,
      fileName,
      extension,
      size: stat.size,
      order: leadingOrderNumber(fileName),
    });
  }

  if (issues.length) {
    throw new Error(`Could not infer screenshot asset targets:\n- ${issues.join('\n- ')}`);
  }
  if (!files.length) throw new Error(`No screenshot assets found in ${rootDir}.`);

  const groups = new Map();
  for (const file of files) {
    const key = `${file.locale}\u0000${file.displayType}`;
    if (!groups.has(key)) {
      groups.set(key, {
        locale: file.locale,
        displayType: file.displayType,
        files: [],
      });
    }
    groups.get(key).files.push(file);
  }

  const targets = [...groups.values()]
    .map((target) => validateAndSortTargetFiles(target))
    .sort((left, right) => (
      collator.compare(left.locale, right.locale)
      || collator.compare(left.displayType, right.displayType)
    ));

  return {
    kind: 'screenshots',
    rootDir: absoluteRoot,
    folderShape,
    targets,
  };
}

export async function loadAssetSyncState(request, env, { versionString }) {
  const appVersion = await loadAppVersion(request, env, versionString, false);
  const versionLocalizations = await fetchAllPages(request, `/appStoreVersions/${encodeURIComponent(appVersion.id)}/appStoreVersionLocalizations?limit=200`);
  return {
    appVersion,
    versionLocalizations,
  };
}

export async function buildScreenshotSyncPlan({ request, state, manifest, versionString }) {
  if (!state.appVersion) throw new Error(`Could not find ASC version ${versionString}.`);
  assertEditableAppVersionForAssets(state.appVersion);

  const localizationsByLocale = new Map((state.versionLocalizations ?? state.localizations ?? [])
    .map((localization) => [localization.attributes?.locale, localization]));
  const setsByLocalizationId = new Map();
  const screenshotCountsBySetId = new Map();
  const missingLocalesSeen = new Set();
  const targets = [];

  for (const target of manifest.targets) {
    const localization = localizationsByLocale.get(target.locale) ?? null;
    let existingSet = null;
    let existingScreenshotCount = 0;

    if (localization) {
      if (!setsByLocalizationId.has(localization.id)) {
        const sets = await fetchAllPages(request, `/appStoreVersionLocalizations/${encodeURIComponent(localization.id)}/appScreenshotSets?limit=200`);
        setsByLocalizationId.set(localization.id, sets);
      }

      const matchingSets = setsByLocalizationId.get(localization.id)
        .filter((set) => set.attributes?.screenshotDisplayType === target.displayType);
      if (matchingSets.length > 1) {
        throw new Error(`ASC has multiple screenshot sets for ${target.locale}/${target.displayType}; resolve duplicate sets in App Store Connect first.`);
      }

      existingSet = matchingSets[0] ?? null;
      if (existingSet) {
        if (!screenshotCountsBySetId.has(existingSet.id)) {
          const existingScreenshots = await fetchAllPages(request, `/appScreenshotSets/${encodeURIComponent(existingSet.id)}/appScreenshots?limit=50`);
          screenshotCountsBySetId.set(existingSet.id, existingScreenshots.length);
        }
        existingScreenshotCount = screenshotCountsBySetId.get(existingSet.id);
      }
    }

    targets.push({
      locale: target.locale,
      displayType: target.displayType,
      files: target.files,
      localizationId: localization?.id ?? null,
      createLocalization: !localization && !missingLocalesSeen.has(target.locale),
      needsCreatedLocalization: !localization,
      existingSet,
      existingScreenshotCount,
      action: existingSet ? 'replace' : 'create',
    });

    if (!localization) missingLocalesSeen.add(target.locale);
  }

  return {
    kind: 'screenshots',
    versionString,
    appVersion: state.appVersion,
    manifest,
    targets,
  };
}

export function summarizeScreenshotSyncPlan(plan) {
  const totalFiles = plan.targets.reduce((sum, target) => sum + target.files.length, 0);
  const rows = [
    `screenshots version ${plan.versionString}: ${totalFiles} file${totalFiles === 1 ? '' : 's'} across ${plan.targets.length} set${plan.targets.length === 1 ? '' : 's'}`,
  ];

  for (const target of plan.targets) {
    const action = target.action === 'replace'
      ? `REPLACE ${target.existingScreenshotCount} existing with ${target.files.length}`
      : `CREATE ${target.files.length}`;
    const localization = target.createLocalization ? ' + create localization' : '';
    rows.push(`${target.locale}/${target.displayType}: ${action} screenshot${target.files.length === 1 ? '' : 's'}${localization} (${target.files.map((file) => file.relativePath).join(', ')})`);
  }

  return rows;
}

export function changedScreenshotAssetSets(plan) {
  return plan.targets.map((target) => `appScreenshotSets:${target.locale}/${target.displayType}`);
}

export async function applyScreenshotSyncPlan(request, plan, {
  uploadRequest = uploadBinaryOperation,
  readFile = fs.readFileSync,
  logger = console,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  waitIntervalMs = DEFAULT_WAIT_INTERVAL_MS,
  sleep = delay,
} = {}) {
  const uploadedScreenshots = [];
  const assetSets = [];
  const localizationIdsByLocale = new Map(plan.targets
    .filter((target) => target.localizationId)
    .map((target) => [target.locale, target.localizationId]));

  for (const target of plan.targets) {
    let localizationId = localizationIdsByLocale.get(target.locale) ?? null;
    if (!localizationId && target.createLocalization) {
      const localizationResponse = await request(
        'POST',
        '/appStoreVersionLocalizations',
        buildAppStoreVersionLocalizationCreatePayload(target.locale, plan.appVersion.id),
      );
      localizationId = localizationResponse.data.id;
      localizationIdsByLocale.set(target.locale, localizationId);
      logger.log(`${target.locale}: created appStoreVersionLocalization ${localizationId}`);
    }
    if (!localizationId) {
      throw new Error(`Could not resolve appStoreVersionLocalization for ${target.locale}.`);
    }

    if (target.existingSet) {
      await request('DELETE', `/appScreenshotSets/${encodeURIComponent(target.existingSet.id)}`);
      logger.log(`${target.locale}/${target.displayType}: deleted existing screenshot set ${target.existingSet.id}`);
    }

    const screenshotSetResponse = await request(
      'POST',
      '/appScreenshotSets',
      buildAppScreenshotSetCreatePayload(target.displayType, localizationId),
    );
    const screenshotSetId = screenshotSetResponse.data.id;
    const screenshotIds = [];

    for (const file of target.files) {
      const fileBuffer = readFile(file.absolutePath);
      const reservationResponse = await request(
        'POST',
        '/appScreenshots',
        buildAppScreenshotCreatePayload({ ...file, size: fileBuffer.length }, screenshotSetId),
      );
      const screenshot = reservationResponse.data;
      const uploadOperations = screenshot.attributes?.uploadOperations ?? [];
      await uploadAssetOperations(uploadOperations, fileBuffer, { uploadRequest });
      const checksum = md5(fileBuffer);
      await request(
        'PATCH',
        `/appScreenshots/${encodeURIComponent(screenshot.id)}`,
        buildAppScreenshotCommitPayload(screenshot.id, checksum),
      );
      screenshotIds.push(screenshot.id);
      uploadedScreenshots.push({
        id: screenshot.id,
        locale: target.locale,
        displayType: target.displayType,
        relativePath: file.relativePath,
        checksum,
      });
    }

    await request(
      'PATCH',
      `/appScreenshotSets/${encodeURIComponent(screenshotSetId)}/relationships/appScreenshots`,
      buildScreenshotSetOrderPayload(screenshotIds),
    );
    assetSets.push({
      id: screenshotSetId,
      locale: target.locale,
      displayType: target.displayType,
      screenshotIds,
    });

    await verifyScreenshotProcessing(request, screenshotIds, {
      waitTimeoutMs,
      waitIntervalMs,
      sleep,
    });
    logger.log(`${target.locale}/${target.displayType}: uploaded and verified ${screenshotIds.length} screenshot${screenshotIds.length === 1 ? '' : 's'}`);
  }

  return {
    uploadedScreenshots,
    assetSets,
  };
}

export function buildAppStoreVersionLocalizationCreatePayload(locale, appVersionId) {
  validateLocaleCode(locale);
  return {
    data: {
      type: 'appStoreVersionLocalizations',
      attributes: {
        locale,
      },
      relationships: {
        appStoreVersion: {
          data: {
            type: 'appStoreVersions',
            id: appVersionId,
          },
        },
      },
    },
  };
}

export function buildAppScreenshotSetCreatePayload(displayType, localizationId) {
  validateDisplayType(displayType);
  return {
    data: {
      type: 'appScreenshotSets',
      attributes: {
        screenshotDisplayType: displayType,
      },
      relationships: {
        appStoreVersionLocalization: {
          data: {
            type: 'appStoreVersionLocalizations',
            id: localizationId,
          },
        },
      },
    },
  };
}

export function buildAppScreenshotCreatePayload(file, screenshotSetId) {
  return {
    data: {
      type: 'appScreenshots',
      attributes: {
        fileSize: file.size,
        fileName: file.fileName,
      },
      relationships: {
        appScreenshotSet: {
          data: {
            type: 'appScreenshotSets',
            id: screenshotSetId,
          },
        },
      },
    },
  };
}

export function buildAppScreenshotCommitPayload(screenshotId, checksum) {
  return {
    data: {
      type: 'appScreenshots',
      id: screenshotId,
      attributes: {
        uploaded: true,
        sourceFileChecksum: checksum,
      },
    },
  };
}

export function buildScreenshotSetOrderPayload(screenshotIds) {
  return {
    data: screenshotIds.map((id) => ({
      type: 'appScreenshots',
      id,
    })),
  };
}

export async function uploadAssetOperations(uploadOperations, fileBuffer, { uploadRequest = uploadBinaryOperation } = {}) {
  if (!Array.isArray(uploadOperations) || !uploadOperations.length) {
    throw new Error('ASC did not return upload operations for the screenshot reservation.');
  }

  for (const operation of uploadOperations) {
    const offset = Number(operation.offset ?? 0);
    const length = Number(operation.length ?? (fileBuffer.length - offset));
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > fileBuffer.length) {
      throw new Error(`Invalid upload operation byte range: offset=${operation.offset}, length=${operation.length}.`);
    }
    await uploadRequest(operation, fileBuffer.subarray(offset, offset + length));
  }
}

export async function verifyScreenshotProcessing(request, screenshotIds, {
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  waitIntervalMs = DEFAULT_WAIT_INTERVAL_MS,
  sleep = delay,
} = {}) {
  const pending = new Set(screenshotIds);
  const deadline = Date.now() + waitTimeoutMs;

  while (pending.size) {
    for (const screenshotId of [...pending]) {
      const response = await request('GET', `/appScreenshots/${encodeURIComponent(screenshotId)}`);
      const deliveryState = response.data?.attributes?.assetDeliveryState;
      const state = deliveryState?.state;
      if (state === 'COMPLETE') {
        pending.delete(screenshotId);
      } else if (state === 'FAILED') {
        const errors = (deliveryState.errors ?? [])
          .map((error) => error.detail ?? error.message ?? JSON.stringify(error))
          .join('; ');
        throw new Error(`Screenshot ${screenshotId} failed processing${errors ? `: ${errors}` : '.'}`);
      }
    }

    if (!pending.size) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for screenshot processing: ${[...pending].join(', ')}.`);
    }
    await sleep(Math.min(waitIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function runAssetSync({
  argv = process.argv.slice(2),
  readFile = fs.readFileSync,
  ascRequest = null,
  uploadRequest = uploadBinaryOperation,
  logger = console,
  checkKeyFile = true,
  sleep = delay,
} = {}) {
  const args = parseAssetArgs(argv);
  if (args.help) {
    printAssetHelp(logger);
    return;
  }

  const env = validateEnv(parseEnvFile(readFile(expandHome(args.env), 'utf8')), { checkKeyFile });
  const versionString = args.version ?? env.ASC_VERSION;
  if (!versionString) throw new Error('Missing version string. Provide --version <version>.');

  const manifest = scanScreenshotAssets(args.assets, { folderShape: args.folderShape });
  const request = ascRequest ?? createAscClient(env);
  const state = await loadAssetSyncState(request, env, { versionString });
  logger.log(`ASC version ${versionString}: ${state.appVersion.id} state=${state.appVersion.attributes?.appVersionState ?? state.appVersion.attributes?.appStoreState ?? 'unknown'}`);

  const plan = await buildScreenshotSyncPlan({
    request,
    state,
    manifest,
    versionString,
  });

  for (const summary of summarizeScreenshotSyncPlan(plan)) {
    logger.log(summary);
  }

  if (args.mode === 'dry-run') {
    logger.log(`Dry-run complete. Changed asset sets: ${changedScreenshotAssetSets(plan).join(', ') || 'none'}`);
    return;
  }

  const applyResult = await applyScreenshotSyncPlan(request, plan, {
    uploadRequest,
    logger,
    waitTimeoutMs: args.waitTimeoutMs,
    sleep,
  });
  logger.log(`Verified screenshot sync. Uploaded screenshots=${applyResult.uploadedScreenshots.length}, assetSets=${applyResult.assetSets.length}.`);
}

export function printAssetHelp(logger = console) {
  logger.log(`Usage:
  node plugins/asc-marketing-manager/skills/asc-marketing-manager/scripts/asc-sync-assets.mjs --env <path> --assets <dir> --version <version> [--folder-shape auto|locale-first|display-first] --dry-run
  node plugins/asc-marketing-manager/skills/asc-marketing-manager/scripts/asc-sync-assets.mjs --env <path> --assets <dir> --version <version> [--folder-shape auto|locale-first|display-first] --apply`);
}

function validateAndSortTargetFiles(target) {
  if (!target.files.length) throw new Error(`${target.locale}/${target.displayType} has no screenshots.`);
  if (target.files.length > MAX_SCREENSHOTS_PER_SET) {
    throw new Error(`${target.locale}/${target.displayType} has ${target.files.length}/${MAX_SCREENSHOTS_PER_SET} screenshots.`);
  }

  const seenOrders = new Map();
  for (const file of target.files) {
    if (file.order === null) continue;
    const prior = seenOrders.get(file.order);
    if (prior) {
      throw new Error(`${target.locale}/${target.displayType} has duplicate numeric order ${file.order}: ${prior.relativePath}, ${file.relativePath}.`);
    }
    seenOrders.set(file.order, file);
  }

  return {
    ...target,
    files: [...target.files].sort(compareAssetFiles),
  };
}

function compareAssetFiles(left, right) {
  if (left.order !== null && right.order !== null && left.order !== right.order) return left.order - right.order;
  if (left.order !== null && right.order === null) return -1;
  if (left.order === null && right.order !== null) return 1;
  return collator.compare(left.fileName, right.fileName);
}

function inferTargetFromPath(relativePath, { folderShape }) {
  const directory = path.posix.dirname(toPosixPath(relativePath));
  const parts = directory === '.' ? [] : directory.split('/').filter(Boolean);
  const locales = [];
  const displays = [];

  for (let index = 0; index < parts.length; index += 1) {
    const locale = localeFromPathSegment(parts[index]);
    if (locale) locales.push({ index, value: locale });

    const displayType = displayTypeFromPathSegment(parts[index]);
    if (displayType) displays.push({ index, value: displayType });
  }

  const uniqueLocales = uniqueMatches(locales);
  const uniqueDisplays = uniqueMatches(displays);
  if (uniqueLocales.length !== 1) {
    return { error: uniqueLocales.length ? `multiple locale folders found (${uniqueLocales.map((match) => match.value).join(', ')})` : 'missing locale folder' };
  }
  if (uniqueDisplays.length !== 1) {
    return { error: uniqueDisplays.length ? `multiple display type folders found (${uniqueDisplays.map((match) => match.value).join(', ')})` : 'missing display type folder' };
  }

  const [locale] = uniqueLocales;
  const [display] = uniqueDisplays;
  if (folderShape === 'locale-first' && locale.index > display.index) {
    return { error: 'folder shape is display-first, but --folder-shape locale-first was requested' };
  }
  if (folderShape === 'display-first' && display.index > locale.index) {
    return { error: 'folder shape is locale-first, but --folder-shape display-first was requested' };
  }

  return {
    locale: locale.value,
    displayType: display.value,
  };
}

function uniqueMatches(matches) {
  const byValue = new Map();
  for (const match of matches) {
    if (!byValue.has(match.value)) byValue.set(match.value, match);
  }
  return [...byValue.values()];
}

function localeFromPathSegment(value) {
  const normalizedCode = value.trim().replace('_', '-');
  if (/^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(normalizedCode)) {
    const [language, region] = normalizedCode.split('-');
    const locale = region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase();
    validateLocaleCode(locale);
    return locale;
  }

  const label = normalizeLabel(value);
  const exactLocale = DISPLAY_LABEL_LOCALES.get(label);
  if (exactLocale) return exactLocale;
  const parentheticalLabel = label.replace(/[()]/gu, '').replace(/\s+/gu, ' ').trim();
  return DISPLAY_LABEL_LOCALES.get(parentheticalLabel) ?? null;
}

function displayTypeFromPathSegment(value) {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  if (SCREENSHOT_DISPLAY_TYPES.has(normalized)) return normalized;
  return DISPLAY_ALIASES.get(normalized) ?? null;
}

function normalizeLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}/gu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function leadingOrderNumber(fileName) {
  const match = path.basename(fileName).match(/^(\d+)/u);
  return match ? Number(match[1]) : null;
}

function validateDisplayType(displayType) {
  if (!SCREENSHOT_DISPLAY_TYPES.has(displayType)) {
    throw new Error(`Unsupported screenshot display type: ${displayType}.`);
  }
}

function assertEditableAppVersionForAssets(appVersion) {
  const state = appVersion.attributes?.appVersionState ?? appVersion.attributes?.appStoreState ?? 'unknown';
  if (!EDITABLE_VERSION_STATES.has(state)) {
    throw new Error(`ASC version ${appVersion.attributes?.versionString ?? appVersion.id} is not editable for screenshot assets: state=${state}.`);
  }
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function uploadBinaryOperation(operation, chunk) {
  return new Promise((resolve, reject) => {
    const headers = {};
    for (const header of operation.requestHeaders ?? []) {
      if (!header.name) continue;
      headers[header.name] = header.value ?? '';
    }
    headers['Content-Length'] = String(chunk.length);

    const request = https.request(operation.url, {
      method: operation.method ?? 'PUT',
      headers,
    }, (response) => {
      let data = '';
      response.on('data', (bodyChunk) => {
        data += bodyChunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Asset upload operation failed with status ${response.statusCode}: ${data.slice(0, 1000)}`));
          return;
        }
        resolve({});
      });
    });

    request.on('error', reject);
    request.write(chunk);
    request.end();
  });
}

function walkFiles(rootDir) {
  const results = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .sort((left, right) => collator.compare(left.name, right.name));

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolutePath));
    } else if (entry.isFile()) {
      results.push(absolutePath);
    }
  }

  return results;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
