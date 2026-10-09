/**
 * @file        packages/agent/src/config.js
 * @description Agent config resolution: flags > env > config file > bundled default (url and access key)
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

// §7: "Configuration is read from flags, then environment (THUB_URL,
// THUB_KEY), then ~/.config/thub/agent.json."
const CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'agent.json'),

  // Bundled with the package as a last-resort default, below the user's own
  // config file, so `thub` has something to fall back on before `config set`
  // has ever been run.
  PACKAGE_DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readJsonFile(filePath){
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  catch {
    return {};
  }
}

function readConfigFile(){
  return readJsonFile(CONFIG_PATH);
}

function writeConfigFile(config){
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// `keySource` says where the key came from — `thub key rotate` saves the
// new one only where it can (the config file), and says what to update
// otherwise.
function resolveConnection(flags = {}){
  const file = { ...readJsonFile(PACKAGE_DEFAULT_CONFIG_PATH), ...readConfigFile() },
    url = flags.url || process.env.THUB_URL || file.url,
    [token, keySource] = flags.key ? [flags.key, 'flag']
      : process.env.THUB_KEY ? [process.env.THUB_KEY, 'THUB_KEY']
        : file.key ? [file.key, 'file'] : [null, null];
  if (!url || !token){
    const err = new Error(
      'Missing Coordinator URL or access key. Set them with `thub config set url <url>` and `thub config set key <key>`, ' +
        'or THUB_URL / THUB_KEY, or --url / --key. An admin gives you your key (Users), or create it on your dashboard profile.'
    );
    err.status = 4;
    throw err;
  }
  return { url, token, keySource };
}

module.exports = { CONFIG_PATH, readConfigFile, writeConfigFile, resolveConnection };
