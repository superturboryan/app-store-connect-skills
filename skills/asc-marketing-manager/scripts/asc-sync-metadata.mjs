#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSync } from '../lib/cli.mjs';
import { redactSecrets } from '../lib/asc-sync-core.mjs';

export * from '../lib/asc-sync-core.mjs';
export * from '../lib/sync-plan.mjs';
export * from '../lib/sheet-mapper.mjs';
export * from '../lib/cli.mjs';

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runSync().catch((error) => {
    console.error(redactSecrets(error.message));
    process.exit(1);
  });
}
