const fs = require('fs');
const http = require('http');
const path = require('path');

const { loadEnvFile } = require('./load-env');

loadEnvFile();

const publicDir = path.resolve(__dirname, '../public');
const port = Number.parseInt(process.env.FRONTEND_PORT || '4173', 10);
const host = process.env.FRONTEND_HOST || '127.0.0.1';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function resolveFile(requestPath) {
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const absolutePath = path.normalize(path.join(publicDir, normalizedPath));

  if (!absolutePath.startsWith(publicDir)) {
    return null;
  }

  return absolutePath;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = resolveFile(url.pathname);

  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end('Not Found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = contentTypes[extension] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });

  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
  console.log(`Static frontend available at http://${host}:${port}`);
});
