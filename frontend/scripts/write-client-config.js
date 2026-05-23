const fs = require('fs');
const path = require('path');

const { loadEnvFile } = require('./load-env');

loadEnvFile();

const outputPath = path.resolve(__dirname, '../public/app-config.js');

function normalizeUrl(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\/+$/, '')
    : null;
}

const signalingUrl = normalizeUrl(process.env.TWINDROP_SIGNALING_URL);
const frontendUrl = normalizeUrl(process.env.TWINDROP_FRONTEND_URL);

const content = `window.__TWINDROP_CONFIG__ = {
  signalingUrl: ${signalingUrl ? JSON.stringify(signalingUrl) : 'window.location.origin'},
  frontendUrl: ${frontendUrl ? JSON.stringify(frontendUrl) : 'window.location.origin'}
};\n`;

fs.writeFileSync(outputPath, content, 'utf8');
console.log(`Wrote ${outputPath}`);
