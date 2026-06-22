#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAscClient,
  expandHome,
  parseEnvFile,
  redactSecrets,
  validateEnv,
} from '../lib/asc-sync-core.mjs';

const DEFAULT_TMP_DIR = '/private/tmp';
const BENCHMARK_BUCKET_PRECISION = 4;
const PRICE_ROW_RELATIONSHIPS = ['manualPrices', 'automaticPrices'];

export function parsePricingAuditArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env' || arg === '--out' || arg === '--csv' || arg === '--as-of') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      args[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      index += 1;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--skip-available-price-points') {
      args.skipAvailablePricePoints = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.help) return args;
  if (!args.env) throw new Error('Missing --env <path>.');

  const stamp = auditFileStamp(args.asOf ? new Date(args.asOf) : new Date());
  return {
    ...args,
    out: args.out ?? path.join(DEFAULT_TMP_DIR, `asc-pricing-audit-${stamp}.json`),
    csv: args.csv ?? path.join(DEFAULT_TMP_DIR, `asc-pricing-audit-${stamp}.csv`),
  };
}

export async function runPricingAudit({
  argv = process.argv.slice(2),
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
  mkdir = fs.mkdirSync,
  ascRequest = null,
  logger = console,
  checkKeyFile = true,
  now = new Date(),
} = {}) {
  const args = parsePricingAuditArgs(argv);
  if (args.help) {
    printHelp(logger);
    return null;
  }

  const env = validateEnv(parseEnvFile(readFile(expandHome(args.env), 'utf8')), { checkKeyFile });
  const baseRequest = ascRequest ?? createAscClient(env);
  const request = args.verbose ? withVerboseAscRequest(baseRequest, logger) : baseRequest;
  const auditDate = args.asOf ? new Date(args.asOf) : now;
  if (Number.isNaN(auditDate.getTime())) throw new Error('--as-of must be a valid date or date-time.');

  const state = await loadPricingAuditState(request, env, {
    skipAvailablePricePoints: args.skipAvailablePricePoints,
  });
  const audit = buildPricingAudit(state, {
    appId: env.ASC_APP_ID,
    asOf: auditDate,
  });

  mkdir(path.dirname(expandHome(args.out)), { recursive: true });
  mkdir(path.dirname(expandHome(args.csv)), { recursive: true });
  writeFile(expandHome(args.out), `${JSON.stringify(audit, null, 2)}\n`);
  writeFile(expandHome(args.csv), pricingRowsToCsv(audit.rows));

  logger.log(`Pricing audit complete. schedule=${audit.schedule.id} baseTerritory=${audit.baseTerritory.id ?? 'unknown'} currentTerritories=${audit.summary.currentTerritories} outliers=${audit.summary.outliers}`);
  logger.log(`JSON: ${args.out}`);
  logger.log(`CSV: ${args.csv}`);
  return audit;
}

export async function loadPricingAuditState(ascRequest, env, { skipAvailablePricePoints = false } = {}) {
  const appId = encodeURIComponent(env.ASC_APP_ID);
  const scheduleResponse = await ascRequest('GET', `/apps/${appId}/appPriceSchedule`);
  const schedule = scheduleResponse.data;
  if (!schedule?.id) throw new Error('App Store Connect did not return an app price schedule ID.');

  const scheduleId = encodeURIComponent(schedule.id);
  const [baseTerritoryResponse, manualPrices, automaticPrices, availablePricePoints] = await Promise.all([
    ascRequest('GET', `/appPriceSchedules/${scheduleId}/baseTerritory`),
    fetchPriceRows(ascRequest, schedule.id, 'manualPrices'),
    fetchPriceRows(ascRequest, schedule.id, 'automaticPrices'),
    skipAvailablePricePoints ? Promise.resolve({ data: [], included: [] }) : fetchAvailablePricePoints(ascRequest, env.ASC_APP_ID),
  ]);

  return {
    schedule,
    baseTerritory: baseTerritoryResponse.data ?? null,
    manualPrices,
    automaticPrices,
    availablePricePoints,
  };
}

function withVerboseAscRequest(ascRequest, logger = console) {
  return async function verboseAscRequest(method, apiPath, body = null) {
    const started = Date.now();
    logger.error?.(`ASC ${method} ${apiPath}`);
    try {
      const response = await ascRequest(method, apiPath, body);
      logger.error?.(`ASC ${method} ${apiPath} complete ${Date.now() - started}ms`);
      return response;
    } catch (error) {
      logger.error?.(`ASC ${method} ${apiPath} failed ${Date.now() - started}ms`);
      throw error;
    }
  };
}

export function buildPricingAudit(state, {
  appId,
  asOf = new Date(),
} = {}) {
  const included = buildIncludedMap([
    state.manualPrices,
    state.automaticPrices,
    state.availablePricePoints,
    { included: [state.baseTerritory].filter(Boolean) },
  ]);
  const asOfDate = toDateKey(asOf);
  const manualRows = normalizeAppPriceRows(state.manualPrices.data, included, {
    source: 'manual',
    asOfDate,
  });
  const automaticRows = normalizeAppPriceRows(state.automaticPrices.data, included, {
    source: 'automatic',
    asOfDate,
  });
  const rows = [...manualRows, ...automaticRows].sort(comparePriceRows);
  const currentPrices = selectCurrentTerritoryPrices(rows);
  const availablePricePoints = normalizeAvailablePricePoints(state.availablePricePoints.data, included);
  const ladders = buildTerritoryPriceLadders(availablePricePoints);
  const benchmark = buildGlobalPriceBenchmark(currentPrices, ladders);
  const annotatedCurrentPrices = annotateCurrentPrices(currentPrices, ladders, benchmark);
  const annotatedCurrentPriceById = new Map(annotatedCurrentPrices.map((row) => [row.id, row]));
  const annotatedRows = rows.map((row) => annotatedCurrentPriceById.get(row.id) ?? row);
  const groupedCurrentPrices = groupCurrentPrices(annotatedCurrentPrices);
  const outliers = annotatedCurrentPrices.filter(isPricingOutlier);
  const recommendations = outliers
    .map(buildPricingRecommendation)
    .filter(Boolean)
    .sort(comparePricingRecommendations);
  const upcomingRows = rows.filter((row) => row.activeStatus === 'upcoming');
  const expiredRows = rows.filter((row) => row.activeStatus === 'expired');

  return {
    generatedAt: new Date().toISOString(),
    asOf: asOfDate,
    app: {
      id: appId ?? null,
    },
    schedule: {
      id: state.schedule?.id ?? null,
      type: state.schedule?.type ?? 'appPriceSchedules',
      links: state.schedule?.links ?? {},
    },
    baseTerritory: normalizeTerritory(state.baseTerritory),
    benchmark,
    summary: {
      rows: rows.length,
      manualRows: manualRows.length,
      automaticRows: automaticRows.length,
      currentTerritories: annotatedCurrentPrices.length,
      activeManualTerritories: annotatedCurrentPrices.filter((row) => row.source === 'manual').length,
      activeAutomaticTerritories: annotatedCurrentPrices.filter((row) => row.source === 'automatic').length,
      matchedBand: annotatedCurrentPrices.filter((row) => row.band === 'matched').length,
      highBand: annotatedCurrentPrices.filter((row) => row.band === 'high').length,
      lowBand: annotatedCurrentPrices.filter((row) => row.band === 'low').length,
      otherBand: annotatedCurrentPrices.filter((row) => row.band === 'unclassified').length,
      upcomingRows: upcomingRows.length,
      expiredRows: expiredRows.length,
      outliers: outliers.length,
      actionableRecommendations: recommendations.length,
      availablePricePoints: availablePricePoints.length,
    },
    groupedCurrentPrices,
    recommendations,
    outliers,
    upcomingRows,
    expiredRows,
    currentPrices: annotatedCurrentPrices,
    rows: annotatedRows,
    availablePricePoints,
  };
}

async function fetchPriceRows(ascRequest, scheduleId, relationship) {
  if (!PRICE_ROW_RELATIONSHIPS.includes(relationship)) {
    throw new Error(`Unsupported price relationship: ${relationship}.`);
  }
  return fetchAllDocuments(ascRequest, priceRowsPath(scheduleId, relationship));
}

async function fetchAvailablePricePoints(ascRequest, appId) {
  const params = new URLSearchParams();
  params.set('limit', '200');
  params.set('include', 'territory');
  params.set('fields[appPricePoints]', 'customerPrice,proceeds');
  params.set('fields[territories]', 'currency');
  return fetchAllDocuments(ascRequest, `/apps/${encodeURIComponent(appId)}/appPricePoints?${params.toString()}`);
}

async function fetchAllDocuments(ascRequest, apiPath) {
  const data = [];
  const included = [];
  const seenPaths = new Set();
  let nextPath = apiPath;

  while (nextPath) {
    if (seenPaths.has(nextPath)) throw new Error(`ASC pagination loop detected at ${nextPath}.`);
    seenPaths.add(nextPath);
    const response = await ascRequest('GET', nextPath);
    data.push(...(response.data ?? []));
    included.push(...(response.included ?? []));
    nextPath = response.links?.next ?? null;
  }

  return { data, included };
}

function priceRowsPath(scheduleId, relationship) {
  const params = new URLSearchParams();
  params.set('limit', '200');
  params.set('include', 'appPricePoint,territory');
  params.set('fields[appPricePoints]', 'customerPrice,proceeds');
  params.set('fields[territories]', 'currency');
  return `/appPriceSchedules/${encodeURIComponent(scheduleId)}/${relationship}?${params.toString()}`;
}

function buildIncludedMap(documents) {
  const map = new Map();
  for (const document of documents) {
    for (const item of document?.included ?? []) {
      if (item?.type && item.id) map.set(`${item.type}:${item.id}`, item);
    }
  }
  return map;
}

function normalizeAppPriceRows(rows, included, { source, asOfDate }) {
  return (rows ?? []).map((row) => {
    const pricePointId = row.relationships?.appPricePoint?.data?.id ?? null;
    const pricePoint = pricePointId ? included.get(`appPricePoints:${pricePointId}`) : null;
    const territoryId = row.relationships?.territory?.data?.id
      ?? pricePoint?.relationships?.territory?.data?.id
      ?? null;
    const territory = territoryId ? included.get(`territories:${territoryId}`) : null;
    const customerPrice = normalizePrice(pricePoint?.attributes?.customerPrice);
    const proceeds = normalizePrice(pricePoint?.attributes?.proceeds);
    const activeStatus = priceStatus(row.attributes?.startDate ?? null, row.attributes?.endDate ?? null, asOfDate);
    const normalized = {
      id: row.id,
      type: row.type ?? 'appPrices',
      source,
      manual: row.attributes?.manual ?? source === 'manual',
      territory: territoryId,
      currency: territory?.attributes?.currency ?? null,
      customerPrice,
      proceeds,
      pricePointId,
      startDate: row.attributes?.startDate ?? null,
      endDate: row.attributes?.endDate ?? null,
      activeStatus,
    };
    normalized.band = activeStatus;
    return normalized;
  });
}

function normalizeAvailablePricePoints(rows, included) {
  return (rows ?? []).map((row) => {
    const territoryId = row.relationships?.territory?.data?.id ?? null;
    const territory = territoryId ? included.get(`territories:${territoryId}`) : null;
    return {
      id: row.id,
      type: row.type ?? 'appPricePoints',
      territory: territoryId,
      currency: territory?.attributes?.currency ?? null,
      customerPrice: normalizePrice(row.attributes?.customerPrice),
      proceeds: normalizePrice(row.attributes?.proceeds),
    };
  }).sort(comparePricePoints);
}

function normalizeTerritory(territory) {
  return {
    id: territory?.id ?? null,
    type: territory?.type ?? 'territories',
    currency: territory?.attributes?.currency ?? null,
  };
}

function selectCurrentTerritoryPrices(rows) {
  const byTerritory = new Map();
  for (const row of rows) {
    if (row.activeStatus !== 'active' || !row.territory) continue;
    const existing = byTerritory.get(row.territory);
    if (!existing || (existing.source === 'automatic' && row.source === 'manual')) {
      byTerritory.set(row.territory, row);
    }
  }
  return [...byTerritory.values()].sort(comparePriceRows);
}

function groupCurrentPrices(currentPrices) {
  const groups = new Map();
  for (const row of currentPrices) {
    const key = `${row.currency ?? 'unknown'} ${row.customerPrice ?? 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        currency: row.currency,
        customerPrice: row.customerPrice,
        territories: [],
        count: 0,
      });
    }
    const group = groups.get(key);
    group.territories.push(row.territory);
    group.count += 1;
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      territories: group.territories.sort(),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function buildTerritoryPriceLadders(availablePricePoints) {
  const ladders = new Map();
  for (const point of availablePricePoints) {
    if (!point.territory) continue;
    if (!ladders.has(point.territory)) {
      ladders.set(point.territory, {
        territory: point.territory,
        currency: point.currency,
        points: [],
      });
    }
    ladders.get(point.territory).points.push(point);
  }

  for (const ladder of ladders.values()) {
    ladder.points = ladder.points
      .slice()
      .sort(comparePricePoints)
      .map((point, index, points) => ({
        ...point,
        tierIndex: index,
        tierCount: points.length,
        tierPercentile: calculateTierPercentile(index, points.length),
      }));
  }

  return ladders;
}

function buildGlobalPriceBenchmark(currentPrices, ladders) {
  const ladderRows = currentPrices
    .map((row) => addTierContext(row, ladders))
    .filter((row) => Number.isFinite(row.priceTierPercentile));
  if (ladderRows.length < 2) {
    return {
      scope: 'global-ladder',
      available: false,
      reason: 'insufficientPriceLadderData',
      sampleSize: ladderRows.length,
      coverage: 0,
      confidence: 'low',
    };
  }

  const buckets = new Map();
  for (const row of ladderRows) {
    const bucketKey = roundNumber(row.priceTierPercentile, BENCHMARK_BUCKET_PRECISION).toFixed(BENCHMARK_BUCKET_PRECISION);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        key: bucketKey,
        percentile: roundNumber(row.priceTierPercentile, BENCHMARK_BUCKET_PRECISION),
        count: 0,
        territories: [],
      });
    }
    const bucket = buckets.get(bucketKey);
    bucket.count += 1;
    bucket.territories.push(row.territory);
  }

  const rankedBuckets = [...buckets.values()].sort((a, b) => (
    b.count - a.count
      || b.percentile - a.percentile
      || a.key.localeCompare(b.key)
  ));
  const [selected, runnerUp] = rankedBuckets;
  const coverage = selected.count / ladderRows.length;

  return {
    scope: 'global-ladder',
    available: true,
    sampleSize: ladderRows.length,
    coverage: roundNumber(coverage, 4),
    confidence: benchmarkConfidence(coverage, selected.count, Boolean(runnerUp && runnerUp.count === selected.count)),
    percentile: selected.percentile,
    territories: selected.territories.sort(),
    tieBrokenTowardHigherPrice: Boolean(runnerUp && runnerUp.count === selected.count),
  };
}

function annotateCurrentPrices(currentPrices, ladders, benchmark) {
  return currentPrices.map((row) => {
    const tieredRow = addTierContext(row, ladders);
    if (!benchmark.available || !Number.isFinite(tieredRow.priceTierPercentile) || !tieredRow.availablePricePointCount) {
      return {
        ...tieredRow,
        benchmarkScope: benchmark.scope,
        benchmarkCoverage: benchmark.coverage ?? 0,
        benchmarkConfidence: benchmark.confidence ?? 'low',
        benchmarkAvailable: benchmark.available,
        benchmarkReason: benchmark.reason ?? 'insufficientPriceLadderData',
        band: 'unclassified',
      };
    }

    const targetIndex = percentileToTierIndex(benchmark.percentile, tieredRow.availablePricePointCount);
    const targetPoint = ladders.get(tieredRow.territory)?.points[targetIndex] ?? null;
    const deltaTiers = targetIndex - tieredRow.priceTierIndex;
    const band = deltaTiers === 0 ? 'matched' : deltaTiers > 0 ? 'low' : 'high';

    return {
      ...tieredRow,
      benchmarkScope: benchmark.scope,
      benchmarkCoverage: benchmark.coverage,
      benchmarkConfidence: benchmark.confidence,
      benchmarkAvailable: benchmark.available,
      benchmarkPercentile: benchmark.percentile,
      benchmarkTerritories: benchmark.territories,
      benchmarkPriceTierIndex: targetIndex,
      benchmarkPriceTierPosition: formatTierPosition(targetIndex, tieredRow.availablePricePointCount),
      benchmarkCustomerPrice: targetPoint?.customerPrice ?? null,
      benchmarkProceeds: targetPoint?.proceeds ?? null,
      benchmarkPricePointId: targetPoint?.id ?? null,
      deltaTiers,
      band,
    };
  });
}

function addTierContext(row, ladders) {
  const ladder = ladders.get(row.territory);
  if (!ladder || ladder.points.length === 0) {
    return {
      ...row,
      priceTierIndex: null,
      priceTierPercentile: null,
      priceTierPosition: null,
      availablePricePointCount: 0,
    };
  }

  const priceTierIndex = ladder.points.findIndex((point) => (
    point.id === row.pricePointId
      || (point.customerPrice === row.customerPrice && point.proceeds === row.proceeds)
  ));
  if (priceTierIndex === -1) {
    return {
      ...row,
      priceTierIndex: null,
      priceTierPercentile: null,
      priceTierPosition: null,
      availablePricePointCount: ladder.points.length,
    };
  }

  const priceTierPoint = ladder.points[priceTierIndex];
  return {
    ...row,
    priceTierIndex,
    priceTierPercentile: priceTierPoint.tierPercentile,
    priceTierPosition: formatTierPosition(priceTierIndex, ladder.points.length),
    availablePricePointCount: ladder.points.length,
  };
}

function buildPricingRecommendation(row) {
  if (!isPricingOutlier(row)) return null;

  const direction = row.deltaTiers > 0 ? 'raise' : 'review-lower';
  const estimatedProceedsDelta = numericDifference(row.benchmarkProceeds, row.proceeds);
  return {
    territory: row.territory,
    currency: row.currency,
    source: row.source,
    direction,
    confidence: row.benchmarkConfidence,
    benchmarkCoverage: row.benchmarkCoverage,
    currentCustomerPrice: row.customerPrice,
    currentProceeds: row.proceeds,
    currentPricePointId: row.pricePointId,
    recommendedCustomerPrice: row.benchmarkCustomerPrice,
    recommendedProceeds: row.benchmarkProceeds,
    recommendedPricePointId: row.benchmarkPricePointId,
    currentPriceTierPosition: row.priceTierPosition,
    recommendedPriceTierPosition: row.benchmarkPriceTierPosition,
    deltaTiers: row.deltaTiers,
    estimatedProceedsDelta,
    rationale: row.deltaTiers > 0
      ? `Raise toward the dominant active price tier used in ${formatCoverage(row.benchmarkCoverage)} of benchmarked territories to improve per-unit proceeds while staying aligned with the broader market set.`
      : `Review whether this market is intentionally priced above the dominant active price tier used in ${formatCoverage(row.benchmarkCoverage)} of benchmarked territories.`,
  };
}

function isPricingOutlier(row) {
  return row.band === 'low' || row.band === 'high';
}

function priceStatus(startDate, endDate, asOfDate) {
  const start = startDate ? toDateKey(startDate) : null;
  const end = endDate ? toDateKey(endDate) : null;
  if (start && start > asOfDate) return 'upcoming';
  if (end && end < asOfDate) return 'expired';
  return 'active';
}

function toDateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Invalid date.');
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}.`);
  return date.toISOString().slice(0, 10);
}

function normalizePrice(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function comparePriceRows(a, b) {
  return String(a.territory ?? '').localeCompare(String(b.territory ?? ''))
    || sourceRank(a.source) - sourceRank(b.source)
    || String(a.startDate ?? '').localeCompare(String(b.startDate ?? ''))
    || String(a.endDate ?? '').localeCompare(String(b.endDate ?? ''))
    || String(a.pricePointId ?? '').localeCompare(String(b.pricePointId ?? ''));
}

function comparePricePoints(a, b) {
  return String(a.territory ?? '').localeCompare(String(b.territory ?? ''))
    || Number(a.customerPrice ?? 0) - Number(b.customerPrice ?? 0)
    || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

function comparePricingRecommendations(a, b) {
  return recommendationPriority(b) - recommendationPriority(a)
    || String(a.territory ?? '').localeCompare(String(b.territory ?? ''));
}

function sourceRank(source) {
  return source === 'manual' ? 0 : 1;
}

export function pricingRowsToCsv(rows) {
  const columns = [
    'territory',
    'currency',
    'source',
    'customerPrice',
    'proceeds',
    'band',
    'priceTierPosition',
    'benchmarkCustomerPrice',
    'benchmarkProceeds',
    'benchmarkPriceTierPosition',
    'deltaTiers',
    'benchmarkCoverage',
    'benchmarkConfidence',
    'suggestedAction',
    'pricePointId',
    'startDate',
    'endDate',
    'activeStatus',
    'manual',
    'appPriceId',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(csvValue(row, column))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvValue(row, column) {
  if (column === 'appPriceId') return row.id;
  if (column === 'suggestedAction') {
    if (row.band === 'low') return 'raise';
    if (row.band === 'high') return 'review-lower';
    return '';
  }
  return row[column];
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (!/[",\n\r]/.test(stringValue)) return stringValue;
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function auditFileStamp(date) {
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function calculateTierPercentile(index, count) {
  if (!count) return null;
  if (count === 1) return 1;
  return index / (count - 1);
}

function percentileToTierIndex(percentile, count) {
  if (!count) return null;
  if (count === 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(percentile * (count - 1))));
}

function formatTierPosition(index, count) {
  if (!Number.isInteger(index) || !count) return null;
  return `${index + 1}/${count}`;
}

function benchmarkConfidence(coverage, count, tieBroken) {
  if (count >= 3 && coverage >= 0.6 && !tieBroken) return 'high';
  if (count >= 2 && coverage >= 0.5) return tieBroken ? 'medium' : 'high';
  return 'low';
}

function roundNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(decimals));
}

function numericDifference(nextValue, currentValue) {
  const nextNumber = Number(nextValue);
  const currentNumber = Number(currentValue);
  if (!Number.isFinite(nextNumber) || !Number.isFinite(currentNumber)) return null;
  return roundNumber(nextNumber - currentNumber, 2);
}

function formatCoverage(coverage) {
  if (!Number.isFinite(coverage)) return '0%';
  return `${Math.round(coverage * 100)}%`;
}

function recommendationPriority(recommendation) {
  const coverage = Number.isFinite(recommendation.benchmarkCoverage) ? recommendation.benchmarkCoverage : 0;
  const tierDistance = Math.abs(recommendation.deltaTiers ?? 0);
  const directionBias = recommendation.direction === 'raise' ? 1 : 0;
  return (coverage * 1000) + (tierDistance * 10) + directionBias;
}

function printHelp(logger = console) {
  logger.log(`Usage:
  node skills/asc-pricing-manager/scripts/asc-audit-pricing.mjs --env <path> [--out <json>] [--csv <csv>] [--as-of <date>] [--skip-available-price-points] [--verbose]`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runPricingAudit().catch((error) => {
    console.error(redactSecrets(error.message));
    process.exit(1);
  });
}
