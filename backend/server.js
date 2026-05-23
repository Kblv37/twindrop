const { loadEnvFile } = require('./scripts/load-env');
const { startServer } = require('./src/server');

loadEnvFile();

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[fatal]', error);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
