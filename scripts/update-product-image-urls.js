const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ID = 'edencafe-d9095';
const CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'configstore', 'firebase-tools.json');
const MAP_PATH = path.join(__dirname, '..', 'Images', 'generated', 'menu', 'image-map.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function refreshFirebaseCliToken() {
  try {
    execFileSync('cmd.exe', ['/c', 'firebase', 'projects:list', '--json'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore',
      timeout: 60000,
    });
  } catch (error) {
    // If refresh fails but the current access token still works, the update can continue.
  }
}

function getAccessToken() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('Firebase CLI config was not found. Please run firebase login first.');
  }
  const config = readJson(CONFIG_PATH);
  const token = config.tokens && config.tokens.access_token;
  if (!token) throw new Error('Firebase CLI access token was not found. Please run firebase login first.');
  return token;
}

function firestoreDocUrl(collection, id) {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      body = { raw: text };
    }
  }
  return { response, body };
}

async function updateItem(token, item, dryRun) {
  const collection = item.collection || 'products';
  const url = firestoreDocUrl(collection, item.id);
  const headers = { Authorization: `Bearer ${token}` };

  const existing = await requestJson(url, { headers });
  if (!existing.response.ok) {
    return {
      id: item.id,
      name: item.name,
      status: 'skipped',
      reason: existing.response.status === 404 ? 'not-found' : `read-${existing.response.status}`,
    };
  }

  const currentUrl = existing.body?.fields?.imageUrl?.stringValue || '';
  if (currentUrl === item.imageUrl) {
    return { id: item.id, name: item.name, status: 'unchanged', imageUrl: item.imageUrl };
  }
  if (dryRun) {
    return { id: item.id, name: item.name, status: 'dry-run', from: currentUrl, to: item.imageUrl };
  }

  const params = new URLSearchParams();
  params.append('updateMask.fieldPaths', 'imageUrl');
  params.append('updateMask.fieldPaths', 'updatedAt');

  const update = await requestJson(`${url}?${params.toString()}`, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        imageUrl: { stringValue: item.imageUrl },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });

  if (!update.response.ok) {
    return { id: item.id, name: item.name, status: 'failed', reason: `write-${update.response.status}`, detail: update.body };
  }
  return { id: item.id, name: item.name, status: 'updated', imageUrl: item.imageUrl };
}

async function main() {
  const dryRun = !process.argv.includes('--apply');
  const map = readJson(MAP_PATH);
  const items = Array.isArray(map.items) ? map.items : [];
  if (!items.length) throw new Error(`No items found in ${MAP_PATH}`);

  refreshFirebaseCliToken();
  const token = getAccessToken();

  const results = [];
  for (const item of items) {
    results.push(await updateItem(token, item, dryRun));
  }

  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({ dryRun, counts, results }, null, 2));
  if (results.some(item => item.status === 'failed')) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
