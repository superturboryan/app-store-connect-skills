#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets } from '../lib/asc-sync-core.mjs';
import { runAssetSync } from '../lib/assets.mjs';

export * from '../lib/asc-sync-core.mjs';
export * from '../lib/assets.mjs';

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runAssetSync().catch((error) => {
    console.error(redactSecrets(error.message));
    process.exit(1);
  });
}
