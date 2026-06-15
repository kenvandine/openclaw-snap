#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');

// ----------------------------------------------------------------------------
// Per-snap parameters (env-driven, with OpenClaw defaults so this file is
// byte-for-byte reusable across every Node-based "claw" snap).  Set these in
// the snap's snapcraft.yaml under the lemonade app's 'environment:' block:
//   CLAW_CLI_NAME        snap/app name + log prefix      (default: openclaw)
//   CLAW_TITLE           human-facing product name       (default: OpenClaw)
//   CLAW_CONFIG_FILE     absolute path to the CLI config (default: ~/.<cli>/<cli>.json)
//   CLAW_RECIPE_CATEGORY recipes/ subdir in the catalog  (default: openclaw)
//   CLAW_RECIPE_REF      git ref of the recipe catalog   (default: openclaw_recipes)
//   CLAW_LEMONADE_PORT   lemonade-server port            (default: 13305)
// ----------------------------------------------------------------------------
const CLI = process.env.CLAW_CLI_NAME || 'openclaw';
const TITLE = process.env.CLAW_TITLE || 'OpenClaw';

const INFERENCE_SNAPS = (process.env.CLAW_INFERENCE_SNAPS || 'gemma3 gemma4 deepseek-r1 nemotron-3-nano nemotron-3-nano-omni qwen-vl')
  .split(/\s+/).filter(Boolean);

const LEMONADE_HOST = process.env.CLAW_LEMONADE_HOST || '127.0.0.1';
const LEMONADE_PORT = Number(process.env.CLAW_LEMONADE_PORT || 13305);
const LEMONADE_API = '/api/v1';
const LEMONADE_BASE_URL = `http://${LEMONADE_HOST}:${LEMONADE_PORT}${LEMONADE_API}`;

const homeDir = process.env.HOME || os.homedir();
const configDir = path.join(homeDir, `.${CLI}`);
const configFile = process.env.CLAW_CONFIG_FILE || path.join(configDir, `${CLI}.json`);
const stateFile = path.join(configDir, 'lemonade-onboarding.json');
const GITHUB_API_HOST = 'api.github.com';
const RECIPE_CATEGORY = process.env.CLAW_RECIPE_CATEGORY || 'openclaw';
const RECIPE_REF = process.env.CLAW_RECIPE_REF || 'openclaw_recipes';
const GITHUB_RECIPES_PATH = `/repos/kenvandine/recipes/contents/${RECIPE_CATEGORY}?ref=${RECIPE_REF}`;
const GITHUB_USER_AGENT = `${CLI}-snap`;

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    'usage: setup-providers.js <command> [options]\n' +
    '\n' +
    'commands:\n' +
    '  detect                     exit 0 if lemonade is reachable\n' +
    '  configure [--recipe NAME]  write the CLI config non-interactively\n' +
    '  onboard [--first-run]      run the interactive lemonade onboarding TUI\n' +
    '  inference-snap             run the interactive inference snap picker TUI\n'
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage(0);
  }

  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === '--first-run') {
      options.firstRun = true;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--recipe') {
      if (typeof rest[index + 1] !== 'string' || rest[index + 1].startsWith('--')) {
        throw new Error('missing value for --recipe');
      }
      options.recipe = rest[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { command, options };
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function formatLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) {
    return 'text';
  }

  return labels.join(', ');
}

function inputTypesFromLabels(labels) {
  const inputs = ['text'];

  if (Array.isArray(labels) && labels.includes('vision')) {
    inputs.push('image');
  }

  return inputs;
}

function normalizeModelId(modelId) {
  return String(modelId || '').replace(/^(user|extra|builtin)\./, '');
}

function recipeMatchesModel(recipe, model) {
  const modelId = typeof model === 'string' ? model : model?.id;
  if (typeof modelId !== 'string' || modelId === '') {
    return false;
  }

  return modelId === recipe.modelName || normalizeModelId(modelId) === normalizeModelId(recipe.modelName);
}

function findRuntimeModelForRecipe(recipe, runtimeModels) {
  return runtimeModels.find(model => recipeMatchesModel(recipe, model));
}

function httpRequest({ protocol = 'http:', method, hostname, port, path: urlPath, headers }, body) {
  const transport = protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({ method, hostname, port, path: urlPath, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: raw });
      });
    });

    req.setTimeout(3000, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

async function httpGet(hostname, port, urlPath) {
  return httpRequest({
    method: 'GET',
    hostname,
    port,
    path: urlPath,
  });
}

async function httpPost(hostname, port, urlPath, data) {
  const body = JSON.stringify(data);

  return httpRequest({
    method: 'POST',
    hostname,
    port,
    path: urlPath,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

function parseJsonResponse(response, context) {
  try {
    return response.body ? JSON.parse(response.body) : {};
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error.message}`);
  }
}

async function httpGetUrl(urlString, headers = {}) {
  const url = new URL(urlString);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  return httpRequest({
    protocol: url.protocol,
    method: 'GET',
    hostname: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    headers,
  });
}

async function probeLemonadeModels() {
  try {
    const response = await httpGet(LEMONADE_HOST, LEMONADE_PORT, `${LEMONADE_API}/models`);
    if (response.status !== 200) {
      return null;
    }

    const payload = JSON.parse(response.body);
    const models = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.data)
        ? payload.data
        : [];

    return models.filter(model => model && typeof model.id === 'string');
  } catch {
    return null;
  }
}

function recipeToPullPayload(recipe) {
  const payload = {
    model_name: recipe.modelName,
    recipe: recipe.recipe,
  };

  if (recipe.checkpoints && typeof recipe.checkpoints === 'object' && Object.keys(recipe.checkpoints).length > 0) {
    payload.checkpoints = recipe.checkpoints;
  } else if (typeof recipe.checkpoint === 'string' && recipe.checkpoint !== '') {
    payload.checkpoint = recipe.checkpoint;
  }

  if (typeof recipe.mmproj === 'string' && recipe.mmproj !== '') {
    payload.mmproj = recipe.mmproj;
  }

  if (Array.isArray(recipe.labels)) {
    if (recipe.labels.includes('vision')) {
      payload.vision = true;
    }
    if (recipe.labels.includes('reasoning')) {
      payload.reasoning = true;
    }
    if (recipe.labels.includes('embeddings')) {
      payload.embedding = true;
    }
    if (recipe.labels.includes('reranking')) {
      payload.reranking = true;
    }
  }

  return payload;
}

function recipesFromRuntimeModels(runtimeModels) {
  return runtimeModels.map(model => ({
    file: `${model.id}.json`,
    title: model.id.replace(/^user\./, ''),
    modelName: model.id,
    size: null,
    labels: [],
    contextWindow: model.context_window || 32768,
  }));
}

async function fetchRecipeCatalogFromGitHub() {
  const indexResponse = await httpRequest({
    protocol: 'https:',
    method: 'GET',
    hostname: GITHUB_API_HOST,
    port: 443,
    path: GITHUB_RECIPES_PATH,
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': GITHUB_USER_AGENT,
    },
  });

  if (indexResponse.status !== 200) {
    throw new Error(`GitHub returned ${indexResponse.status} for the recipe index`);
  }

  const files = JSON.parse(indexResponse.body)
    .filter(item => item.type === 'file' && item.name.endsWith('.json') && typeof item.download_url === 'string');

  if (files.length === 0) {
    throw new Error('GitHub returned an empty recipe list');
  }

  return Promise.all(files.map(async item => {
    const recipeResponse = await httpGetUrl(item.download_url, {
      'Accept': 'application/json',
      'User-Agent': GITHUB_USER_AGENT,
    });

    if (recipeResponse.status !== 200) {
      throw new Error(`GitHub returned ${recipeResponse.status} for ${item.name}`);
    }

    const recipe = JSON.parse(recipeResponse.body);
    return {
      file: item.name,
      title: item.name.replace(/\.json$/, ''),
      modelName: recipe.model_name,
      size: typeof recipe.size === 'number' ? recipe.size : null,
      labels: Array.isArray(recipe.labels) ? recipe.labels : [],
      contextWindow: recipe.recipe_options?.ctx_size || 32768,
      checkpoint: typeof recipe.checkpoint === 'string' ? recipe.checkpoint : null,
      checkpoints: recipe.checkpoints && typeof recipe.checkpoints === 'object' ? recipe.checkpoints : null,
      mmproj: typeof recipe.mmproj === 'string' ? recipe.mmproj : null,
      recipe: typeof recipe.recipe === 'string' ? recipe.recipe : 'llamacpp',
      recipeOptions: recipe.recipe_options && typeof recipe.recipe_options === 'object' ? recipe.recipe_options : {},
    };
  }));
}

async function loadRecipeCatalog(runtimeModels) {
  try {
    return {
      recipes: await fetchRecipeCatalogFromGitHub(),
      source: 'github',
    };
  } catch (error) {
    if (runtimeModels.length > 0) {
      return {
        recipes: recipesFromRuntimeModels(runtimeModels),
        source: 'runtime',
      };
    }

    throw new Error(`failed to fetch ${TITLE} Lemonade recipes from GitHub: ${error.message}`);
  }
}

function mergeGatewayConfig(existingConfig) {
  const existingGateway = existingConfig.gateway && typeof existingConfig.gateway === 'object'
    ? existingConfig.gateway
    : {};
  const existingAuth = existingGateway.auth && typeof existingGateway.auth === 'object'
    ? existingGateway.auth
    : {};

  return {
    ...existingGateway,
    mode: 'local',
    auth: {
      ...existingAuth,
      mode: 'token',
    },
  };
}

function mergeUpdateConfig(existingConfig) {
  const existingUpdate = existingConfig.update && typeof existingConfig.update === 'object'
    ? existingConfig.update
    : {};

  return {
    ...existingUpdate,
    checkOnStart: false,
  };
}

function mergeAgentDefaults(existingConfig, primaryModel) {
  const existingAgents = existingConfig.agents && typeof existingConfig.agents === 'object'
    ? existingConfig.agents
    : {};
  const existingDefaults = existingAgents.defaults && typeof existingAgents.defaults === 'object'
    ? existingAgents.defaults
    : {};
  const existingModel = existingDefaults.model && typeof existingDefaults.model === 'object'
    ? existingDefaults.model
    : {};
  const existingMemorySearch = existingDefaults.memorySearch && typeof existingDefaults.memorySearch === 'object'
    ? existingDefaults.memorySearch
    : {};

  return {
    ...existingAgents,
    defaults: {
      ...existingDefaults,
      workspace: existingDefaults.workspace || path.join(homeDir, 'workspace'),
      sandbox: existingDefaults.sandbox || { mode: 'off' },
      memorySearch: {
        ...existingMemorySearch,
        enabled: existingMemorySearch.enabled ?? false,
      },
      model: {
        ...existingModel,
        primary: primaryModel,
      },
    },
  };
}

function buildProviderModel(recipe, runtimeModel) {
  return {
    id: runtimeModel?.id || recipe.modelName,
    name: recipe.title,
    reasoning: false,
    input: inputTypesFromLabels(recipe.labels),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: runtimeModel?.context_window || recipe.contextWindow || 32768,
    maxTokens: runtimeModel?.max_tokens || 4096,
  };
}

function writeProviderConfig(selectedRecipe, recipes, runtimeModels) {
  const existingConfig = readJson(configFile) || {};
  const selectedRuntimeModel = findRuntimeModelForRecipe(selectedRecipe, runtimeModels);
  const selectedProviderModelId = selectedRuntimeModel?.id || selectedRecipe.modelName;
  const providerModels = recipes.map(recipe => buildProviderModel(recipe, findRuntimeModelForRecipe(recipe, runtimeModels)));
  const existingModels = existingConfig.models && typeof existingConfig.models === 'object'
    ? existingConfig.models
    : {};
  const existingProviders = existingModels.providers && typeof existingModels.providers === 'object'
    ? existingModels.providers
    : {};

  const config = {
    ...existingConfig,
    gateway: mergeGatewayConfig(existingConfig),
    update: mergeUpdateConfig(existingConfig),
    models: {
      ...existingModels,
      mode: existingModels.mode || 'replace',
      providers: {
        ...existingProviders,
        lemonade: {
          baseUrl: LEMONADE_BASE_URL,
          apiKey: 'lemonade',
          api: 'openai-completions',
          models: providerModels,
        },
      },
    },
    agents: mergeAgentDefaults(existingConfig, `lemonade/${selectedProviderModelId}`),
  };

  writeJson(configFile, config);
}

async function tryLoadRecipe(recipe) {
  const pullResponse = await httpPost(
    LEMONADE_HOST,
    LEMONADE_PORT,
    `${LEMONADE_API}/pull`,
    recipeToPullPayload(recipe)
  );

  const pullPayload = parseJsonResponse(pullResponse, '/api/v1/pull');
  if (pullResponse.status < 200 || pullResponse.status >= 300 || pullPayload.status === 'error') {
    throw new Error(pullPayload.message || `Lemonade pull failed with status ${pullResponse.status}`);
  }

  const loadPayload = {
    model_name: recipe.modelName,
    save_options: true,
    ...recipe.recipeOptions,
  };
  const loadResponse = await httpPost(
    LEMONADE_HOST,
    LEMONADE_PORT,
    `${LEMONADE_API}/load`,
    loadPayload
  );
  const loadResponsePayload = parseJsonResponse(loadResponse, '/api/v1/load');
  if (loadResponse.status < 200 || loadResponse.status >= 300 || loadResponsePayload.status === 'error') {
    throw new Error(loadResponsePayload.message || `Lemonade load failed with status ${loadResponse.status}`);
  }

  return {
    pullMessage: pullPayload.message || '',
    loadMessage: loadResponsePayload.message || '',
  };
}

function preferredRecipe(recipes, runtimeModels, requestedRecipe) {
  if (requestedRecipe) {
    const lowered = requestedRecipe.toLowerCase();
    const exactMatch = recipes.find(recipe =>
      recipe.title.toLowerCase() === lowered ||
      recipe.file.toLowerCase() === lowered ||
      recipe.modelName.toLowerCase() === lowered);

    if (!exactMatch) {
      throw new Error(`unknown lemonade recipe: ${requestedRecipe}`);
    }

    return exactMatch;
  }

  const loadedRecipe = recipes.find(recipe => runtimeModels.some(model => recipeMatchesModel(recipe, model)));
  return loadedRecipe || recipes[0];
}

function renderRecipeLine(recipe, isLoaded) {
  const size = typeof recipe.size === 'number' ? `${recipe.size} GB` : 'size unknown';
  const loaded = isLoaded ? 'loaded now' : 'recipe';
  return `${recipe.title} (${size}, ${formatLabels(recipe.labels)}, ${loaded})`;
}

async function promptYesNo(rl, prompt, defaultValue = true) {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';

  while (true) {
    const answer = (await rl.question(`${prompt} ${suffix} `)).trim().toLowerCase();
    if (answer === '') {
      return defaultValue;
    }
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }
  }
}

async function promptForRecipe(rl, recipes, runtimeModels) {
  const defaultRecipe = preferredRecipe(recipes, runtimeModels);
  const defaultIndex = recipes.findIndex(recipe => recipe.modelName === defaultRecipe.modelName);

  process.stdout.write(`\nAvailable Lemonade recipes for ${TITLE}:\n`);
  recipes.forEach((recipe, index) => {
    process.stdout.write(`  ${index + 1}. ${renderRecipeLine(recipe, runtimeModels.some(model => recipeMatchesModel(recipe, model)))}\n`);
  });
  process.stdout.write('\n');

  while (true) {
    const answer = (await rl.question(`Choose a model [${defaultIndex + 1}]: `)).trim();
    if (answer === '') {
      return recipes[defaultIndex];
    }

    const selectedIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= recipes.length) {
      return recipes[selectedIndex - 1];
    }
  }
}

function saveOnboardingState(data) {
  writeJson(stateFile, {
    updatedAt: new Date().toISOString(),
    ...data,
  });
}

async function configureFromRecipe(recipe, recipes, runtimeModels) {
  let activationResult = null;
  if (!runtimeModels.some(model => recipeMatchesModel(recipe, model))) {
    activationResult = await tryLoadRecipe(recipe);
  }
  const updatedRuntimeModels = await probeLemonadeModels();
  const finalRuntimeModels = Array.isArray(updatedRuntimeModels) ? updatedRuntimeModels : runtimeModels;

  writeProviderConfig(recipe, recipes, finalRuntimeModels);

  const recipeIsLoaded = finalRuntimeModels.some(model => recipeMatchesModel(recipe, model));
  return { activationResult, recipeIsLoaded, runtimeModels: finalRuntimeModels };
}

async function runDetect() {
  const models = await probeLemonadeModels();
  if (models === null) {
    process.stderr.write(`${CLI}: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
    process.exit(1);
  }

  process.stdout.write(`${CLI}: found lemonade-server at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
  if (models.length > 0) {
    process.stdout.write(`${CLI}: loaded models: ${models.map(model => model.id).join(', ')}\n`);
  }
}

async function runConfigure(options) {
  const runtimeModels = await probeLemonadeModels();
  if (runtimeModels === null) {
    process.stderr.write(`${CLI}: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
    process.exit(1);
  }

  const { recipes, source } = await loadRecipeCatalog(runtimeModels);
  const recipe = preferredRecipe(recipes, runtimeModels, options.recipe);
  const result = await configureFromRecipe(recipe, recipes, runtimeModels);

  saveOnboardingState({
    decision: 'configured',
    recipe: recipe.title,
    modelName: recipe.modelName,
  });

  process.stdout.write(`${CLI}: configured Lemonade provider with ${recipe.title}\n`);
  if (source !== 'github') {
    process.stdout.write(`${CLI}: GitHub recipe catalog was unavailable; using the currently loaded Lemonade models instead\n`);
  }
  if (result.activationResult?.pullMessage) {
    process.stdout.write(`${CLI}: ${result.activationResult.pullMessage}\n`);
  }
  if (result.activationResult?.loadMessage) {
    process.stdout.write(`${CLI}: ${result.activationResult.loadMessage}\n`);
  }
  if (!result.recipeIsLoaded) {
    process.stdout.write(`${CLI}: Lemonade did not report ${recipe.title} as loaded yet; check Lemonade for download or backend errors\n`);
  }
}

async function runOnboard(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${CLI}: interactive Lemonade onboarding requires a terminal\n`);
    process.exit(options.firstRun ? 0 : 1);
  }

  if (fs.existsSync(configFile) && !options.force) {
    process.stdout.write(`${CLI}: config already exists at ${configFile}\n`);
    process.exit(0);
  }

  const priorState = readJson(stateFile);
  if (options.firstRun && priorState?.decision === 'declined' && !options.force) {
    process.exit(0);
  }

  const runtimeModels = await probeLemonadeModels();
  if (runtimeModels === null) {
    if (options.firstRun) {
      process.stdout.write(`${CLI}: Lemonade is not running on this host; continuing without local model setup\n`);
      process.exit(0);
    }

    process.stderr.write(`${CLI}: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
    process.exit(1);
  }

  const { recipes, source } = await loadRecipeCatalog(runtimeModels);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\n${TITLE} detected Lemonade at http://${LEMONADE_HOST}:${LEMONADE_PORT}.\n`);
    process.stdout.write(`This will configure ${TITLE} to use a local Lemonade model provider.\n`);
    if (source !== 'github') {
      process.stdout.write('GitHub recipe metadata is unavailable right now, so the menu is based on the models Lemonade already has loaded.\n');
    }

    if (options.firstRun) {
      const shouldConfigure = await promptYesNo(rl, `Configure ${TITLE} to use Lemonade now?`, true);
      if (!shouldConfigure) {
        saveOnboardingState({ decision: 'declined' });
        process.stdout.write(`${CLI}: skipped Lemonade setup; run '${CLI}.lemonade' later to enable it\n`);
        process.exit(0);
      }
    }

    const selectedRecipe = await promptForRecipe(rl, recipes, runtimeModels);
    const confirmed = await promptYesNo(
      rl,
      `Use ${selectedRecipe.title} as ${TITLE}'s primary Lemonade model?`,
      true
    );

    if (!confirmed) {
      saveOnboardingState({ decision: 'declined' });
      process.stdout.write(`${CLI}: no changes made; run '${CLI}.lemonade' when you want to configure Lemonade\n`);
      process.exit(0);
    }

    const result = await configureFromRecipe(selectedRecipe, recipes, runtimeModels);
    saveOnboardingState({
      decision: 'configured',
      recipe: selectedRecipe.title,
      modelName: selectedRecipe.modelName,
    });

    process.stdout.write(`\n${CLI}: configured Lemonade provider with ${selectedRecipe.title}\n`);
    process.stdout.write(`${CLI}: primary model → lemonade/${selectedRecipe.modelName}\n`);
    if (result.activationResult?.pullMessage) {
      process.stdout.write(`${CLI}: ${result.activationResult.pullMessage}\n`);
    }
    if (result.activationResult?.loadMessage) {
      process.stdout.write(`${CLI}: ${result.activationResult.loadMessage}\n`);
    }

    if (!result.recipeIsLoaded) {
      process.stdout.write(
        `${CLI}: Lemonade did not report ${selectedRecipe.title} as loaded yet; check Lemonade for download or backend errors\n`
      );
    }
  } finally {
    rl.close();
  }
}

// ----------------------------------------------------------------------------
// Inference snap discovery and configuration
// ----------------------------------------------------------------------------

function snapGet(snapName, key) {
  const result = spawnSync(snapName, ['get', key], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout.trim() || null;
}

function snapInstalled(snapName) {
  const result = spawnSync('snap', ['list', snapName], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0 && !result.error;
}

function getInferenceSnapBaseUrl(snapName) {
  if (!snapInstalled(snapName)) {
    return null;
  }
  const port = snapGet(snapName, 'http.port');
  if (!port) {
    return null;
  }
  const host = snapGet(snapName, 'http.host') || '127.0.0.1';
  const basePath = snapGet(snapName, 'http.base-path') || 'v1';
  return `http://${host}:${port}/${basePath}`;
}

async function probeInferenceSnapModels(baseUrl) {
  try {
    const response = await httpGetUrl(`${baseUrl}/models`);
    if (response.status !== 200) {
      return null;
    }
    const payload = JSON.parse(response.body);
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models.filter(m => m && typeof m.id === 'string');
  } catch {
    return null;
  }
}

async function discoverInferenceSnaps() {
  const entries = [];
  for (const snapName of INFERENCE_SNAPS) {
    const baseUrl = getInferenceSnapBaseUrl(snapName);
    if (!baseUrl) {
      continue;
    }
    const models = await probeInferenceSnapModels(baseUrl);
    if (!models || models.length === 0) {
      continue;
    }
    for (const model of models) {
      entries.push({ snapName, baseUrl, model });
    }
  }
  return entries;
}

function writeInferenceSnapProviderConfig(snapName, baseUrl, model) {
  const existingConfig = readJson(configFile) || {};
  const existingModels = existingConfig.models && typeof existingConfig.models === 'object'
    ? existingConfig.models
    : {};
  const existingProviders = existingModels.providers && typeof existingModels.providers === 'object'
    ? existingModels.providers
    : {};

  const config = {
    ...existingConfig,
    gateway: mergeGatewayConfig(existingConfig),
    update: mergeUpdateConfig(existingConfig),
    models: {
      ...existingModels,
      mode: existingModels.mode || 'replace',
      providers: {
        ...existingProviders,
        [snapName]: {
          baseUrl,
          api: 'openai-completions',
          models: [{
            id: model.id,
            name: model.id,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 4096,
          }],
        },
      },
    },
    agents: mergeAgentDefaults(existingConfig, `${snapName}/${model.id}`),
  };

  writeJson(configFile, config);
}

async function runInferenceSnap() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${CLI}: interactive inference snap picker requires a terminal\n`);
    process.exit(1);
  }

  process.stdout.write(`${CLI}: scanning for inference snaps...\n`);
  const entries = await discoverInferenceSnaps();

  if (entries.length === 0) {
    process.stderr.write(`${CLI}: no inference snaps detected\n`);
    process.stderr.write(`${CLI}: install one with: sudo snap install gemma4\n`);
    process.stderr.write(`${CLI}: then run '${CLI}.inference-snap' again\n`);
    process.exit(1);
  }

  process.stdout.write(`\n${TITLE} detected the following inference snaps:\n\n`);
  entries.forEach(({ snapName, baseUrl, model }, index) => {
    process.stdout.write(`  ${index + 1}. ${snapName}/${model.id}  (${baseUrl})\n`);
  });
  process.stdout.write('\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let selected;
  try {
    while (true) {
      const answer = (await rl.question(`Model number [1]: `)).trim();
      const idx = answer === '' ? 1 : Number.parseInt(answer, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= entries.length) {
        selected = entries[idx - 1];
        break;
      }
    }
  } finally {
    rl.close();
  }

  writeInferenceSnapProviderConfig(selected.snapName, selected.baseUrl, selected.model);
  process.stdout.write(`${CLI}: primary model → ${selected.snapName}/${selected.model.id}\n`);
  process.stdout.write(`${CLI}: wrote ${configFile}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'detect':
      await runDetect();
      return;
    case 'configure':
      await runConfigure(options);
      return;
    case 'onboard':
      await runOnboard(options);
      return;
    case 'inference-snap':
      await runInferenceSnap();
      return;
    default:
      usage(1);
  }
}

main().catch(error => {
  process.stderr.write(`${CLI}: setup-providers failed: ${error.message}\n`);
  process.exit(1);
});
