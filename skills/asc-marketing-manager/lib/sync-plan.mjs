import {
  applyLocalizationChanges,
  assertEditableForChanges,
  buildAppInfoDiff,
  buildAppStoreVersionPatchPayload,
  buildReviewDetailDiff,
  buildReviewDetailPayload,
  buildVersionAttributeDiff,
  buildVersionLocalizationDiff,
  fetchAllPages,
  loadAscState,
  summarizeDiff,
  summarizeReviewDiff,
  summarizeVersionDiff,
} from './asc-sync-core.mjs';

export function buildSyncPlan({
  state,
  desired,
  versionString,
  desiredAppInfoLocales,
  desiredVersionLocales,
}) {
  if (Object.keys(desiredAppInfoLocales).length && !state.appInfo) {
    throw new Error('Could not find appInfo resource for appInfo localization sync.');
  }

  const appInfoChanges = buildAppInfoDiff(state.appInfoLocalizations, desiredAppInfoLocales);
  const versionLocalizationChanges = buildVersionLocalizationDiff(state.versionLocalizations, desiredVersionLocales);
  const versionAttributeChange = buildVersionAttributeDiff(state.appVersion, desired.version, versionString);
  const reviewDetailChange = buildReviewDetailDiff(state.reviewDetail, desired.review);
  const changes = { appInfoChanges, versionLocalizationChanges, versionAttributeChange, reviewDetailChange };

  assertEditableForChanges(state.appVersion, changes);

  const operations = [
    {
      resource: 'appInfoLocalizations',
      kind: 'localizations',
      changes: appInfoChanges,
      parentId: state.appInfo?.id ?? null,
      summary: () => (appInfoChanges.length ? summarizeDiff(appInfoChanges, { title: 'appInfo localizations' }) : null),
      changedResources: () => appInfoChanges
        .filter((change) => change.changed)
        .map((change) => `${change.resourceType}:${change.locale}`),
    },
    {
      resource: 'appStoreVersions',
      kind: 'version',
      change: versionAttributeChange,
      summary: () => summarizeVersionDiff(versionAttributeChange, versionString),
      changedResources: () => (versionAttributeChange.changed ? ['appStoreVersions'] : []),
    },
    {
      resource: 'appStoreVersionLocalizations',
      kind: 'localizations',
      changes: versionLocalizationChanges,
      parentId: state.appVersion?.id ?? null,
      summary: () => (versionLocalizationChanges.length ? summarizeDiff(versionLocalizationChanges, { title: 'version localizations' }) : null),
      changedResources: () => versionLocalizationChanges
        .filter((change) => change.changed)
        .map((change) => `${change.resourceType}:${change.locale}`),
    },
    {
      resource: 'appStoreReviewDetails',
      kind: 'review',
      change: reviewDetailChange,
      summary: () => (desired.review ? summarizeReviewDiff(reviewDetailChange) : null),
      changedResources: () => (reviewDetailChange.changed ? ['appStoreReviewDetails'] : []),
    },
  ];

  return {
    versionString,
    desired,
    desiredAppInfoLocales,
    desiredVersionLocales,
    state,
    changes,
    operations,
  };
}

export function summarizeSyncPlan(plan) {
  return plan.operations
    .map((operation) => operation.summary())
    .filter(Boolean);
}

export function changedSyncResources(plan) {
  return plan.operations.flatMap((operation) => operation.changedResources());
}

export async function applySyncPlan(request, plan) {
  const { state, changes } = plan;
  if (!state.appVersion) {
    throw new Error(`ASC version ${plan.versionString} was not created.`);
  }

  if (changes.versionAttributeChange.changed && changes.versionAttributeChange.action === 'update') {
    await request('PATCH', `/appStoreVersions/${encodeURIComponent(state.appVersion.id)}`, buildAppStoreVersionPatchPayload(state.appVersion.id, changes.versionAttributeChange.fields));
  }

  const updatedAppInfo = state.appInfo
    ? await applyLocalizationChanges(request, changes.appInfoChanges, state.appInfo.id)
    : [];
  let versionLocalizationChanges = changes.versionLocalizationChanges;
  if (updatedAppInfo.length && changes.versionLocalizationChanges.some((change) => change.action === 'create')) {
    const refreshedVersionLocalizations = await loadVersionLocalizations(request, state.appVersion.id);
    versionLocalizationChanges = buildVersionLocalizationDiff(refreshedVersionLocalizations, plan.desiredVersionLocales);
  }
  const updatedVersionLocalizations = await applyLocalizationChanges(request, versionLocalizationChanges, state.appVersion.id);

  let updatedReview = false;
  if (changes.reviewDetailChange.changed) {
    const method = changes.reviewDetailChange.action === 'create' ? 'POST' : 'PATCH';
    const apiPath = changes.reviewDetailChange.action === 'create'
      ? '/appStoreReviewDetails'
      : `/appStoreReviewDetails/${encodeURIComponent(changes.reviewDetailChange.id)}`;
    await request(method, apiPath, buildReviewDetailPayload(changes.reviewDetailChange, state.appVersion.id));
    updatedReview = true;
  }

  return { updatedAppInfo, updatedVersionLocalizations, updatedReview };
}

async function loadVersionLocalizations(request, appVersionId) {
  return fetchAllPages(request, `/appStoreVersions/${encodeURIComponent(appVersionId)}/appStoreVersionLocalizations?limit=200`);
}

export async function verifySyncPlan(request, ascEnv, plan) {
  const verifyState = await loadAscState(request, ascEnv, { versionString: plan.versionString });
  const verifyAppInfoFailures = buildAppInfoDiff(verifyState.appInfoLocalizations, plan.desiredAppInfoLocales)
    .filter((change) => change.changed)
    .map((change) => change.locale);
  const verifyVersionFailures = buildVersionLocalizationDiff(verifyState.versionLocalizations, plan.desiredVersionLocales)
    .filter((change) => change.changed)
    .map((change) => change.locale);
  const verifyVersionAttributeFailure = buildVersionAttributeDiff(verifyState.appVersion, plan.desired.version, plan.versionString).changed;
  const verifyReviewFailure = buildReviewDetailDiff(verifyState.reviewDetail, plan.desired.review).changed;

  if (verifyAppInfoFailures.length || verifyVersionFailures.length || verifyVersionAttributeFailure || verifyReviewFailure) {
    throw new Error(`Verification failed for: ${[
      ...verifyAppInfoFailures.map((locale) => `appInfo:${locale}`),
      ...verifyVersionFailures.map((locale) => `version:${locale}`),
      verifyVersionAttributeFailure ? 'appStoreVersions' : null,
      verifyReviewFailure ? 'review' : null,
    ].filter(Boolean).join(', ')}.`);
  }
}
