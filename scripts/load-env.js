const fs = require('fs');
const path = require('path');

function normalizeValue(value) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadEnvFile(envFilePath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envFilePath)) {
    return;
  }

  const content = fs.readFileSync(envFilePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = normalizeValue(value);
  }
}

module.exports = { loadEnvFile };
