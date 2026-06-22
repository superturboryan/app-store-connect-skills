import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPricingAudit,
  parsePricingAuditArgs,
  pricingRowsToCsv,
  runPricingAudit,
} from '../scripts/asc-audit-pricing.mjs';

test('given pricing audit args, when parsing them, then env is required and tmp outputs are defaulted', () => {
  // Given / When
  const args = parsePricingAuditArgs(['--env', '/tmp/pricing.env', '--as-of', '2026-06-16']);

  // Then
  assert.equal(args.env, '/tmp/pricing.env');
  assert.match(args.out, /^\/private\/tmp\/asc-pricing-audit-/);
  assert.match(args.csv, /^\/private\/tmp\/asc-pricing-audit-/);
  assert.throws(() => parsePricingAuditArgs([]), /Missing --env/);
});

test('given paginated pricing resources, when running the audit, then current territory prices and outputs are built', async () => {
  // Given
  const outputs = [];
  const writes = new Map();
  const madeDirs = [];
  const { calls, request } = pricingRoutes([
    route('/apps/1234567890/appPriceSchedule', {
      data: {
        id: '1234567890',
        type: 'appPriceSchedules',
        links: { self: 'https://api.appstoreconnect.apple.com/v1/appPriceSchedules/1234567890' },
      },
    }),
    route('/appPriceSchedules/1234567890/baseTerritory', {
      data: territory('USA', 'USD'),
    }),
    routeStarts('/appPriceSchedules/1234567890/manualPrices?', {
      data: [
        appPrice('manual-usa-active', {
          manual: true,
          territory: 'USA',
          pricePoint: 'pp-usa-599',
        }),
        appPrice('manual-can-expired', {
          manual: true,
          territory: 'CAN',
          pricePoint: 'pp-can-249',
          endDate: '2026-01-01',
        }),
      ],
      included: [
        appPricePoint('pp-usa-599', '5.99', '4.19', 'USA'),
        appPricePoint('pp-can-249', '2.49', '1.74', 'CAN'),
        territory('USA', 'USD'),
        territory('CAN', 'CAD'),
      ],
      links: { next: 'https://api.appstoreconnect.apple.com/v1/appPriceSchedules/1234567890/manualPrices?cursor=next' },
    }),
    route('https://api.appstoreconnect.apple.com/v1/appPriceSchedules/1234567890/manualPrices?cursor=next', {
      data: [
        appPrice('manual-gbr-upcoming', {
          manual: true,
          territory: 'GBR',
          pricePoint: 'pp-gbr-549',
          startDate: '2026-12-01',
        }),
      ],
      included: [
        appPricePoint('pp-gbr-549', '5.49', '3.84', 'GBR'),
        territory('GBR', 'GBP'),
      ],
    }),
    routeStarts('/appPriceSchedules/1234567890/automaticPrices?', {
      data: [
        appPrice('auto-can-active', {
          manual: false,
          territory: 'CAN',
          pricePoint: 'pp-can-499',
        }),
        appPrice('auto-fra-active', {
          manual: false,
          territory: 'FRA',
          pricePoint: 'pp-fra-149',
        }),
      ],
      included: [
        appPricePoint('pp-can-499', '4.99', '3.49', 'CAN'),
        appPricePoint('pp-fra-149', '1.49', '1.04', 'FRA'),
        territory('CAN', 'CAD'),
        territory('FRA', 'EUR'),
      ],
    }),
    routeStarts('/apps/1234567890/appPricePoints?', {
      data: [
        appPricePoint('pp-usa-099', '0.99', '0.69', 'USA'),
        appPricePoint('pp-usa-299', '2.99', '2.09', 'USA'),
        appPricePoint('pp-usa-599', '5.99', '4.19', 'USA'),
        appPricePoint('pp-can-129', '1.29', '0.90', 'CAN'),
        appPricePoint('pp-can-249', '2.49', '1.74', 'CAN'),
        appPricePoint('pp-can-499', '4.99', '3.49', 'CAN'),
      ],
      included: [
        territory('USA', 'USD'),
        territory('CAN', 'CAD'),
      ],
      links: { next: 'https://api.appstoreconnect.apple.com/v1/apps/1234567890/appPricePoints?cursor=next' },
    }),
    route('https://api.appstoreconnect.apple.com/v1/apps/1234567890/appPricePoints?cursor=next', {
      data: [
        appPricePoint('pp-fra-149', '1.49', '1.04', 'FRA'),
        appPricePoint('pp-fra-299', '2.99', '2.09', 'FRA'),
        appPricePoint('pp-fra-599', '5.99', '4.19', 'FRA'),
      ],
      included: [
        territory('FRA', 'EUR'),
      ],
    }),
  ]);

  // When
  const audit = await runPricingAudit({
    argv: [
      '--env',
      '/tmp/pricing.env',
      '--out',
      '/tmp/audit.json',
      '--csv',
      '/tmp/audit.csv',
      '--as-of',
      '2026-06-16',
    ],
    readFile,
    ascRequest: request,
    checkKeyFile: false,
    writeFile: (filePath, contents) => writes.set(filePath, contents),
    mkdir: (dirPath) => madeDirs.push(dirPath),
    logger: { log: (line) => outputs.push(line) },
  });

  // Then
  assert.deepEqual([...new Set(calls.map((call) => call.method))], ['GET']);
  assert.equal(audit.summary.currentTerritories, 3);
  assert.equal(audit.summary.activeManualTerritories, 1);
  assert.equal(audit.summary.activeAutomaticTerritories, 2);
  assert.equal(audit.summary.matchedBand, 2);
  assert.equal(audit.summary.highBand, 0);
  assert.equal(audit.summary.lowBand, 1);
  assert.equal(audit.summary.outliers, 1);
  assert.equal(audit.summary.actionableRecommendations, 1);
  assert.equal(audit.summary.upcomingRows, 1);
  assert.equal(audit.summary.expiredRows, 1);
  assert.equal(audit.summary.availablePricePoints, 9);
  assert.equal(audit.currentPrices.find((row) => row.territory === 'USA').source, 'manual');
  assert.equal(audit.outliers[0].territory, 'FRA');
  assert.equal(audit.outliers[0].band, 'low');
  assert.equal(audit.outliers[0].benchmarkCustomerPrice, '5.99');
  assert.equal(audit.recommendations[0].territory, 'FRA');
  assert.equal(audit.recommendations[0].direction, 'raise');
  assert.equal(audit.recommendations[0].recommendedCustomerPrice, '5.99');
  assert.equal(writes.get('/tmp/audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
  assert.match(writes.get('/tmp/audit.csv'), /territory,currency,source,customerPrice/);
  assert.match(writes.get('/tmp/audit.csv'), /FRA,EUR,automatic,1\.49,1\.04,low,1\/3,5\.99,4\.19,3\/3,2,0\.6667,high,raise/);
  assert.deepEqual(madeDirs, ['/tmp', '/tmp']);
  assert.match(outputs.join('\n'), /Pricing audit complete/);
});

test('given empty pricing resources, when building an audit, then summary counts are zero', () => {
  // Given
  const state = {
    schedule: { id: 'schedule-1', type: 'appPriceSchedules' },
    baseTerritory: territory('USA', 'USD'),
    manualPrices: { data: [], included: [] },
    automaticPrices: { data: [], included: [] },
    availablePricePoints: { data: [], included: [] },
  };

  // When
  const audit = buildPricingAudit(state, { appId: '1234567890', asOf: new Date('2026-06-16T00:00:00Z') });

  // Then
  assert.equal(audit.summary.currentTerritories, 0);
  assert.equal(audit.summary.rows, 0);
  assert.deepEqual(audit.groupedCurrentPrices, []);
  assert.equal(audit.summary.actionableRecommendations, 0);
});

test('given CSV values that need escaping, when writing pricing rows to CSV, then cells are escaped', () => {
  // Given
  const rows = [{
    id: 'price,1',
    territory: 'USA',
    currency: 'USD',
    source: 'manual',
    customerPrice: '3.99',
    proceeds: '2.79',
    band: 'matched',
    priceTierPosition: '2/3',
    benchmarkCustomerPrice: '3.99',
    benchmarkProceeds: '2.79',
    benchmarkPriceTierPosition: '2/3',
    deltaTiers: 0,
    benchmarkCoverage: 0.75,
    benchmarkConfidence: 'high',
    pricePointId: 'point"1',
    startDate: null,
    endDate: null,
    activeStatus: 'active',
    manual: true,
  }];

  // When
  const csv = pricingRowsToCsv(rows);

  // Then
  assert.match(csv, /"point""1"/);
  assert.match(csv, /"price,1"/);
});

test('given ASC rejects pricing access, when running the audit, then the error is propagated and no files are written', async () => {
  // Given
  const writes = [];
  const request = async () => {
    throw new Error('GET https://api.appstoreconnect.apple.com/v1/apps/1234567890/appPriceSchedule => 403');
  };

  // When / Then
  await assert.rejects(
    runPricingAudit({
      argv: ['--env', '/tmp/pricing.env', '--out', '/tmp/audit.json', '--csv', '/tmp/audit.csv'],
      readFile,
      ascRequest: request,
      checkKeyFile: false,
      writeFile: (...args) => writes.push(args),
      logger: { log: () => {} },
    }),
    /403/,
  );
  assert.deepEqual(writes, []);
});

function readFile(filePath) {
  if (filePath === '/tmp/pricing.env') {
    return `
ASC_KEY_ID=ABCD1234EF
ASC_ISSUER_ID=issuer-id
ASC_KEY_PATH=/tmp/AuthKey_ABCD1234EF.p8
ASC_APP_ID=1234567890
`;
  }
  throw new Error(`Unexpected read ${filePath}`);
}

function pricingRoutes(routes) {
  const calls = [];
  return {
    calls,
    request: async (method, apiPath, body = null) => {
      calls.push({ method, apiPath, body });
      const match = routes.find((candidate) => candidate.matches(apiPath));
      if (!match) throw new Error(`Unexpected call ${method} ${apiPath}`);
      return match.response;
    },
  };
}

function route(apiPath, response) {
  return {
    response,
    matches: (candidate) => candidate === apiPath,
  };
}

function routeStarts(apiPathPrefix, response) {
  return {
    response,
    matches: (candidate) => candidate.startsWith(apiPathPrefix),
  };
}

function appPrice(id, { manual, territory: territoryId, pricePoint, startDate = null, endDate = null }) {
  return {
    id,
    type: 'appPrices',
    attributes: { manual, startDate, endDate },
    relationships: {
      territory: { data: { type: 'territories', id: territoryId } },
      appPricePoint: { data: { type: 'appPricePoints', id: pricePoint } },
    },
  };
}

function appPricePoint(id, customerPrice, proceeds, territoryId) {
  return {
    id,
    type: 'appPricePoints',
    attributes: { customerPrice, proceeds },
    relationships: {
      territory: { data: { type: 'territories', id: territoryId } },
    },
  };
}

function territory(id, currency) {
  return {
    id,
    type: 'territories',
    attributes: { currency },
  };
}
