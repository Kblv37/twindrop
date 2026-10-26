const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(__dirname, '../dist/service-worker.js');
const placeholder = '__TWINDROP_BUILD_VERSION__';

if (!fs.existsSync(outputPath)) {
  console.warn(`[service-worker] ${outputPath} does not exist; skipping version stamp.`);
  process.exit(0);
}

const source = fs.readFileSync(outputPath, 'utf8');

if (!source.includes(placeholder)) {
  console.warn('[service-worker] Build version placeholder was not found; cache version left unchanged.');
  process.exit(0);
}

const version = (
  process.env.CF_PAGES_COMMIT_SHA
  || process.env.GITHUB_SHA
  || process.env.CI_COMMIT_SHA
  || String(Date.now())
).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);

fs.writeFileSync(outputPath, source.replace(placeholder, version), 'utf8');
console.log(`[service-worker] Stamped cache version ${version}`);
