/**
 * @file        scripts/install-default-config.js
 * @description npm postinstall: creates ~/.config/thub/agent.json on a real global install, if it
 *              doesn't already exist, so `npm install -g` leaves a real, editable config file at
 *              the path this package actually reads from — not just an in-package fallback (README §7)
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
  path = require('node:path'),

  CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'agent.json'),

  // Deliberately not a copy of the bundled config.json (which points at
  // http://localhost:8000 for zero-setup `npm run agent` in the monorepo)
  // — url/token are blank so a real install fails loudly with the usual
  // "Missing coordinator URL or token" error until you actually set them,
  // rather than silently looking configured.
  DEFAULT_CONTENT = {
    url: '',
    token: '',
    group: '',
    user: ''
  };

// npm only sets this for an actual `npm install -g` — absent for a plain
// local/workspace install (e.g. this monorepo's own `npm install`).
function isGlobalInstall(){
  return process.env.npm_config_global === 'true';
}

// Best-effort and never fails the `npm install` itself. Never overwrites
// an existing file — a re-install/upgrade must not clobber whatever the
// user already configured.
function main(){
  if (!isGlobalInstall() || fs.existsSync(CONFIG_PATH)){
    return;
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONTENT, null, 2) + '\n', { mode: 0o600 });
    console.log(`thub: created ${CONFIG_PATH} — set it with 'thub config set url <url>' / 'thub config set token <token>'`);
  }
  catch (err){
    console.warn(`thub: could not create ${CONFIG_PATH} automatically (${err.message}).`);
  }
}

main();
