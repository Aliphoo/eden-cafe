const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.EDEN_PRINT_BRIDGE_PORT || 8787);
const HOST = process.env.EDEN_PRINT_BRIDGE_HOST || '127.0.0.1';
const VERSION = '1.0.0';
const MAX_BODY_BYTES = 1024 * 1024;
const EXTRA_ALLOWED_ORIGINS = new Set(
  String(process.env.EDEN_PRINT_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  if (EXTRA_ALLOWED_ORIGINS.has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

function sendJson(res, status, data, origin) {
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  if (status === 204) res.end();
  else res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function parsePayloadBase64(payloadBase64) {
  if (!payloadBase64 || typeof payloadBase64 !== 'string') throw new Error('payloadBase64 is required.');
  const buffer = Buffer.from(payloadBase64, 'base64');
  if (!buffer.length) throw new Error('Print payload is empty.');
  if (buffer.length > MAX_BODY_BYTES) throw new Error('Print payload is too large.');
  return buffer;
}

function validateHost(host) {
  const text = String(host || '').trim();
  if (!text) throw new Error('Printer host is required.');
  if (!/^[a-z0-9.:-]+$/i.test(text)) throw new Error('Printer host contains unsupported characters.');
  return text;
}

function validatePort(port) {
  const number = Number(port || 9100);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Printer port is invalid.');
  return number;
}

function sendToNetworkPrinter({ host, port, payload }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve({ bytes: payload.length });
    };
    socket.setTimeout(8000);
    socket.once('timeout', () => finish(new Error('Printer connection timed out.')));
    socket.once('error', error => finish(error));
    socket.connect(port, host, () => {
      socket.write(payload, error => {
        if (error) return finish(error);
        socket.end();
      });
    });
    socket.once('close', hadError => {
      if (!hadError) finish();
    });
  });
}

function listWindowsPrinters() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Get-Printer | Select-Object -ExpandProperty Name'
    ], { windowsHide: true, timeout: 7000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    });
  });
}

async function handleRequest(req, res) {
  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) return sendJson(res, 403, { ok: false, error: 'Origin is not allowed.' }, origin);
  if (req.method === 'OPTIONS') return sendJson(res, 204, { ok: true }, origin);

  const url = new URL(req.url, `http://${req.headers.host || HOST + ':' + PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'Eden Print Bridge',
        version: VERSION,
        host: HOST,
        port: PORT,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime())
      }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/printers/windows') {
      return sendJson(res, 200, { ok: true, printers: await listWindowsPrinters() }, origin);
    }

    if (req.method === 'POST' && url.pathname === '/print/network') {
      const body = await readJsonBody(req);
      const host = validateHost(body.host);
      const port = validatePort(body.port);
      const payload = parsePayloadBase64(body.payloadBase64);
      const result = await sendToNetworkPrinter({ host, port, payload });
      return sendJson(res, 200, { ok: true, host, port, bytes: result.bytes }, origin);
    }

    return sendJson(res, 404, { ok: false, error: 'Route not found.' }, origin);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message }, origin);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => sendJson(res, 500, { ok: false, error: error.message }, req.headers.origin || ''));
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`Eden Print Bridge ${VERSION} listening on http://${address.address}:${address.port}`);
  console.log(`Host: ${os.hostname()} | Platform: ${process.platform}`);
});
