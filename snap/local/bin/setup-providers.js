#!/usr/bin/env node
'use strict';
// Probes for a local lemonade-server at http://127.0.0.1:13305.  If found,
// attempts to activate the "openclaw" recipe via the Lemonade recipe API, then
// writes a minimal openclaw.json pointing to lemonade as the AI provider.
// Exits 0 on success, 1 if lemonade is not reachable.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const LEMONADE_HOST    = '127.0.0.1';
const LEMONADE_PORT    = 13305;
const LEMONADE_API     = `/api/v1`;
const LEMONADE_BASE_URL = `http://${LEMONADE_HOST}:${LEMONADE_PORT}${LEMONADE_API}`;

const homeDir     = process.env.HOME || require('os').homedir();
const CONFIG_DIR  = path.join(homeDir, '.openclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'openclaw.json');

function httpRequest({ method, hostname, port, path: urlPath, headers }, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname, port, path: urlPath, headers }, res => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpGet(urlPath) {
  return httpRequest({
    method: 'GET',
    hostname: LEMONADE_HOST,
    port: LEMONADE_PORT,
    path: urlPath,
  });
}

function httpPost(urlPath, data) {
  const body = JSON.stringify(data);
  return httpRequest({
    method: 'POST',
    hostname: LEMONADE_HOST,
    port: LEMONADE_PORT,
    path: urlPath,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

async function probeModels() {
  try {
    const res = await httpGet(`${LEMONADE_API}/models`);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body).data || [];
    return data.length > 0 ? data : [];
  } catch {
    return null;
  }
}

// Attempt to activate a named recipe in lemonade (best-effort).
// The recipe API may not exist on all lemonade versions; failures are ignored.
async function tryLoadRecipe(name) {
  try {
    const res = await httpPost(`${LEMONADE_API}/recipe/load`, { name });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function main() {
  // Check if lemonade-server is reachable.
  let models = await probeModels();
  if (models === null) {
    console.error(`openclaw: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}`);
    process.exit(1);
  }

  console.log(`openclaw: found lemonade-server at ${LEMONADE_HOST}:${LEMONADE_PORT}`);

  // Try to activate the openclaw recipe.  If the recipe API exists and the
  // recipe is installed this sets lemonade up with the right model and params.
  const recipeOk = await tryLoadRecipe('openclaw');
  if (recipeOk) {
    console.log('openclaw: activated lemonade openclaw recipe');
    // Re-probe models — the recipe may have changed which models are available.
    const updated = await probeModels();
    if (updated !== null) models = updated;
  }

  if (models.length > 0) {
    console.log(`openclaw: available model(s): ${models.map(m => m.id).join(', ')}`);
  }

  const providerModels = models.map(m => ({
    id:            m.id,
    name:          m.id,
    reasoning:     false,
    input:         ['text'],
    cost:          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context_window || 32768,
    maxTokens:     m.max_tokens    || 4096,
  }));

  const primaryModelId = models[0]?.id;

  const config = {
    gateway: {
      mode: 'local',
      // mode=token with no explicit token value: openclaw auto-generates and
      // persists a token on first gateway start so the CLI can connect without
      // a separate device-identity step.
      auth: { mode: 'token' },
    },
    models: {
      mode: 'replace', // only use explicitly configured local providers
      providers: {
        lemonade: {
          baseUrl: LEMONADE_BASE_URL,
          apiKey:  'lemonade',
          api:     'openai-completions',
          models:  providerModels,
        },
      },
    },
    agents: {
      defaults: {
        workspace: path.join(homeDir, 'workspace'),
        sandbox:   { mode: 'off' },
        ...(primaryModelId && { model: { primary: `lemonade/${primaryModelId}` } }),
      },
    },
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');

  if (primaryModelId) {
    console.log(`openclaw: primary model → lemonade/${primaryModelId}`);
  } else {
    console.log('openclaw: no models available yet; run openclaw models once lemonade has a model downloaded');
  }
}

main().catch(err => {
  console.error(`openclaw: setup-providers failed: ${err.message}`);
  process.exit(1);
});
