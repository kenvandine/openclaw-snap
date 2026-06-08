#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');

const LEMONADE_HOST = '127.0.0.1';
const LEMONADE_PORT = 13305;
const LEMONADE_API = '/api/v1';
const LEMONADE_BASE_URL = `http://${LEMONADE_HOST}:${LEMONADE_PORT}${LEMONADE_API}`;

const homeDir = process.env.HOME || os.homedir();
const configDir = path.join(homeDir, '.openclaw');
const configFile = path.join(configDir, 'openclaw.json');
const stateFile = path.join(configDir, 'lemonade-onboarding.json');
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_RECIPES_PATH = '/repos/kenvandine/recipes/contents/openclaw?ref=openclaw_recipes';
const GITHUB_USER_AGENT = 'openclaw-snap';

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    'usage: setup-providers.js <command> [options]\n' +
    '\n' +
    'commands:\n' +
    '  detect                     exit 0 if lemonade is reachable\n' +
    '  configure [--recipe NAME]  write openclaw config non-interactively\n' +
    '  onboard [--first-run]      run the interactive lemonade onboarding TUI\n'
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

    throw new Error(`failed to fetch OpenClaw Lemonade recipes from GitHub: ${error.message}`);
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

  return {
    ...existingAgents,
    defaults: {
      ...existingDefaults,
      workspace: existingDefaults.workspace || path.join(homeDir, 'workspace'),
      sandbox: existingDefaults.sandbox || { mode: 'off' },
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

  process.stdout.write('\nAvailable Lemonade recipes for OpenClaw:\n');
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
    process.stderr.write(`openclaw: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
    process.exit(1);
  }

  process.stdout.write(`openclaw: found lemonade-server at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
  if (models.length > 0) {
    process.stdout.write(`openclaw: loaded models: ${models.map(model => model.id).join(', ')}\n`);
  }
}

async function runConfigure(options) {
  const runtimeModels = await probeLemonadeModels();
  if (runtimeModels === null) {
    process.stderr.write(`openclaw: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
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

  process.stdout.write(`openclaw: configured Lemonade provider with ${recipe.title}\n`);
  if (source !== 'github') {
    process.stdout.write('openclaw: GitHub recipe catalog was unavailable; using the currently loaded Lemonade models instead\n');
  }
  if (result.activationResult?.pullMessage) {
    process.stdout.write(`openclaw: ${result.activationResult.pullMessage}\n`);
  }
  if (result.activationResult?.loadMessage) {
    process.stdout.write(`openclaw: ${result.activationResult.loadMessage}\n`);
  }
  if (!result.recipeIsLoaded) {
    process.stdout.write(`openclaw: Lemonade did not report ${recipe.title} as loaded yet; check Lemonade for download or backend errors\n`);
  }
}

async function runOnboard(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write('openclaw: interactive Lemonade onboarding requires a terminal\n');
    process.exit(options.firstRun ? 0 : 1);
  }

  if (fs.existsSync(configFile) && !options.force) {
    process.stdout.write(`openclaw: config already exists at ${configFile}\n`);
    process.exit(0);
  }

  const priorState = readJson(stateFile);
  if (options.firstRun && priorState?.decision === 'declined' && !options.force) {
    process.exit(0);
  }

  const runtimeModels = await probeLemonadeModels();
  if (runtimeModels === null) {
    if (options.firstRun) {
      process.stdout.write('openclaw: Lemonade is not running on this host; continuing without local model setup\n');
      process.exit(0);
    }

    process.stderr.write(`openclaw: lemonade-server not detected at ${LEMONADE_HOST}:${LEMONADE_PORT}\n`);
    process.exit(1);
  }

  const { recipes, source } = await loadRecipeCatalog(runtimeModels);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\nOpenClaw detected Lemonade at http://${LEMONADE_HOST}:${LEMONADE_PORT}.\n`);
    process.stdout.write('This will configure OpenClaw to use a local Lemonade model provider.\n');
    if (source !== 'github') {
      process.stdout.write('GitHub recipe metadata is unavailable right now, so the menu is based on the models Lemonade already has loaded.\n');
    }

    if (options.firstRun) {
      const shouldConfigure = await promptYesNo(rl, 'Configure OpenClaw to use Lemonade now?', true);
      if (!shouldConfigure) {
        saveOnboardingState({ decision: 'declined' });
        process.stdout.write("openclaw: skipped Lemonade setup; run 'openclaw.lemonade' later to enable it\n");
        process.exit(0);
      }
    }

    const selectedRecipe = await promptForRecipe(rl, recipes, runtimeModels);
    const confirmed = await promptYesNo(
      rl,
      `Use ${selectedRecipe.title} as OpenClaw's primary Lemonade model?`,
      true
    );

    if (!confirmed) {
      saveOnboardingState({ decision: 'declined' });
      process.stdout.write("openclaw: no changes made; run 'openclaw.lemonade' when you want to configure Lemonade\n");
      process.exit(0);
    }

    const result = await configureFromRecipe(selectedRecipe, recipes, runtimeModels);
    saveOnboardingState({
      decision: 'configured',
      recipe: selectedRecipe.title,
      modelName: selectedRecipe.modelName,
    });

    process.stdout.write(`\nopenclaw: configured Lemonade provider with ${selectedRecipe.title}\n`);
    process.stdout.write(`openclaw: primary model → lemonade/${selectedRecipe.modelName}\n`);
    if (result.activationResult?.pullMessage) {
      process.stdout.write(`openclaw: ${result.activationResult.pullMessage}\n`);
    }
    if (result.activationResult?.loadMessage) {
      process.stdout.write(`openclaw: ${result.activationResult.loadMessage}\n`);
    }

    if (!result.recipeIsLoaded) {
      process.stdout.write(
        `openclaw: Lemonade did not report ${selectedRecipe.title} as loaded yet; check Lemonade for download or backend errors\n`
      );
    }
  } finally {
    rl.close();
  }
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
    default:
      usage(1);
  }
}

main().catch(error => {
  process.stderr.write(`openclaw: setup-providers failed: ${error.message}\n`);
  process.exit(1);
});
