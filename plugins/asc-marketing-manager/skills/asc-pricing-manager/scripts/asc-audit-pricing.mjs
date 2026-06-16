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
} from '../../asc-marketing-manager/lib/asc-sync-core.mjs';

const DEFAULT_HIGH_PRICE = '3.99';
const DEFAULT_LOW_PRICE = '0.99';
const DEFAULT_TMP_DIR = '/private/tmp';
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
  const request = ascRequest ?? createAscClient(env);
  const auditDate = args.asOf ? new Date(args.asOf) : now;
  if (Number.isNaN(auditDate.getTime())) throw new Error('--as-of must be a valid date or date-time.');

  const state = await loadPricingAuditState(request, env);
  const audit = buildPricingAudit(state, {
    appId: env.ASC_APP_ID,
    asOf: auditDate,
    highPrice: DEFAULT_HIGH_PRICE,
    lowPrice: DEFAULT_LOW_PRICE,
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

export async function loadPricingAuditState(ascRequest, env) {
  const appId = encodeURIComponent(env.ASC_APP_ID);
  const scheduleResponse = await ascRequest('GET', `/apps/${appId}/appPriceSchedule`);
  const schedule = scheduleResponse.data;
  if (!schedule?.id) throw new Error('App Store Connect did not return an app price schedule ID.');

  const scheduleId = encodeURIComponent(schedule.id);
  const [baseTerritoryResponse, manualPrices, automaticPrices, availablePricePoints] = await Promise.all([
    ascRequest('GET', `/appPriceSchedules/${scheduleId}/baseTerritory`),
    fetchPriceRows(ascRequest, schedule.id, 'manualPrices'),
    fetchPriceRows(ascRequest, schedule.id, 'automaticPrices'),
    fetchAvailablePricePoints(ascRequest, env.ASC_APP_ID),
  ]);

  return {
    schedule,
    baseTerritory: baseTerritoryResponse.data ?? null,
    manualPrices,
    automaticPrices,
    availablePricePoints,
  };
}

export function buildPricingAudit(state, {
  appId,
  asOf = new Date(),
  highPrice = DEFAULT_HIGH_PRICE,
  lowPrice = DEFAULT_LOW_PRICE,
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
    highPrice,
    lowPrice,
  });
  const automaticRows = normalizeAppPriceRows(state.automaticPrices.data, included, {
    source: 'automatic',
    asOfDate,
    highPrice,
    lowPrice,
  });
  const rows = [...manualRows, ...automaticRows].sort(comparePriceRows);
  const currentPrices = selectCurrentTerritoryPrices(rows);
  const availablePricePoints = normalizeAvailablePricePoints(state.availablePricePoints.data, included);
  const groupedCurrentPrices = groupCurrentPrices(currentPrices);
  const outliers = currentPrices.filter((row) => row.band === 'other');
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
    summary: {
      rows: rows.length,
      manualRows: manualRows.length,
      automaticRows: automaticRows.length,
      currentTerritories: currentPrices.length,
      activeManualTerritories: currentPrices.filter((row) => row.source === 'manual').length,
      activeAutomaticTerritories: currentPrices.filter((row) => row.source === 'automatic').length,
      highBand: currentPrices.filter((row) => row.band === 'high').length,
      lowBand: currentPrices.filter((row) => row.band === 'low').length,
      otherBand: outliers.length,
      upcomingRows: upcomingRows.length,
      expiredRows: expiredRows.length,
      outliers: outliers.length,
      availablePricePoints: availablePricePoints.length,
    },
    groupedCurrentPrices,
    outliers,
    upcomingRows,
    expiredRows,
    currentPrices,
    rows,
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

function normalizeAppPriceRows(rows, included, { source, asOfDate, highPrice, lowPrice }) {
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
    normalized.band = classifyBand(normalized, { highPrice, lowPrice });
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

function classifyBand(row, { highPrice, lowPrice }) {
  if (row.activeStatus !== 'active') return row.activeStatus;
  if (row.customerPrice === lowPrice) return 'low';
  if (row.customerPrice === highPrice && (row.currency === 'USD' || row.source === 'manual')) return 'high';
  return 'other';
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
    'pricePointId',
    'startDate',
    'endDate',
    'activeStatus',
    'band',
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

function printHelp(logger = console) {
  logger.log(`Usage:
  node plugins/asc-marketing-manager/skills/asc-pricing-manager/scripts/asc-audit-pricing.mjs --env <path> [--out <json>] [--csv <csv>] [--as-of <date>]`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runPricingAudit().catch((error) => {
    console.error(redactSecrets(error.message));
    process.exit(1);
  });
}
