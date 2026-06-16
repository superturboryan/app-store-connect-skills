import fs from 'node:fs';

import {
  buildAppStoreVersionCreatePayload,
  createAscClient,
  ensureAppVersion,
  expandFallbackLocales,
  expandHome,
  loadAscState,
  parseArgs,
  parseDesiredMetadata,
  parseEnvFile,
  resolveVersionString,
  validateEnv,
} from './asc-sync-core.mjs';
import {
  applySyncPlan,
  buildSyncPlan,
  changedSyncResources,
  summarizeSyncPlan,
  verifySyncPlan,
} from './sync-plan.mjs';

export function printHelp(logger = console) {
  logger.log(`Usage:
  node plugins/asc-marketing-manager/skills/asc-marketing-manager/scripts/asc-sync-metadata.mjs --env <path> --desired <path> [--version <version>] [--ensure-version] --dry-run
  node plugins/asc-marketing-manager/skills/asc-marketing-manager/scripts/asc-sync-metadata.mjs --env <path> --desired <path> [--version <version>] [--ensure-version] --apply`);
}

export async function runSync({
  argv = process.argv.slice(2),
  readFile = fs.readFileSync,
  ascRequest = null,
  logger = console,
  checkKeyFile = true,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp(logger);
    return;
  }

  const env = validateEnv(parseEnvFile(readFile(expandHome(args.env), 'utf8')), { checkKeyFile });
  const desired = parseDesiredMetadata(readFile(expandHome(args.desired), 'utf8'));
  const versionString = resolveVersionString(args, desired);
  const ascEnv = {
    ...env,
    ASC_PLATFORM: desired.version.platform ?? env.ASC_PLATFORM,
  };
  const desiredAppInfoLocales = expandFallbackLocales(desired.appInfo);
  const desiredVersionLocales = expandFallbackLocales(desired.version);

  const request = ascRequest ?? createAscClient(env);
  let state = await loadAscState(request, ascEnv, { versionString, allowMissingVersion: args.ensureVersion });

  if (!state.appVersion) {
    if (!args.ensureVersion) throw new Error(`Could not find ASC version ${versionString}. Use --ensure-version to create it on apply.`);
    const createPayload = buildAppStoreVersionCreatePayload(env, desired.version, versionString);
    logger.log(`ASC version ${versionString}: would create platform=${createPayload.data.attributes.platform} releaseType=${createPayload.data.attributes.releaseType}`);
    if (args.mode === 'apply') {
      const appVersion = await ensureAppVersion(request, ascEnv, desired.version, versionString);
      logger.log(`Created ASC version ${versionString}: ${appVersion.id}`);
      state = await loadAscState(request, ascEnv, { versionString });
    }
  } else {
    logger.log(`ASC version ${versionString}: ${state.appVersion.id} state=${state.appVersion.attributes?.appVersionState ?? state.appVersion.attributes?.appStoreState ?? 'unknown'}`);
  }

  const plan = buildSyncPlan({
    state,
    desired,
    versionString,
    desiredAppInfoLocales,
    desiredVersionLocales,
  });

  for (const summary of summarizeSyncPlan(plan)) {
    logger.log(summary);
  }

  if (args.mode === 'dry-run') {
    logger.log(`Dry-run complete. Changed resources: ${changedSyncResources(plan).join(', ') || 'none'}`);
    return;
  }

  const applyResult = await applySyncPlan(request, plan);
  await verifySyncPlan(request, ascEnv, plan);
  logger.log(`Verified sync. Updated appInfo=${applyResult.updatedAppInfo.length}, versionLocalizations=${applyResult.updatedVersionLocalizations.length}, review=${applyResult.updatedReview ? 1 : 0}.`);
}
