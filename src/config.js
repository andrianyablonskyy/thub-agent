'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// §7: "Configuration is read from flags, then environment (THUB_URL,
// THUB_TOKEN), then ~/.config/thub/config.json."
const CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'config.json');

// Bundled with the package as a last-resort default, below the user's own
// config file, so `thub` has something to fall back on before `config set`
// has ever been run.
const PACKAGE_DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function readConfigFile() {
  return readJsonFile(CONFIG_PATH);
}

function writeConfigFile(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function resolveConnection(flags = {}) {
  const file = { ...readJsonFile(PACKAGE_DEFAULT_CONFIG_PATH), ...readConfigFile() };
  const url = flags.url || process.env.THUB_URL || file.url;
  const token = flags.token || process.env.THUB_TOKEN || file.token;
  if (!url || !token) {
    const err = new Error(
      'Missing coordinator URL or token. Set with `thub config set url <url>` / `thub config set token <token>`, ' +
        'or THUB_URL / THUB_TOKEN, or --url / --token.'
    );
    err.status = 4;
    throw err;
  }
  return { url, token };
}

module.exports = { CONFIG_PATH, readConfigFile, writeConfigFile, resolveConnection };
