/**
 * @file        packages/agent/src/self-update.js
 * @description Agent self-update: an admin-requested update applied at the start of the next run, plus the
 *              manual `thub check-update` / `thub self-update` commands (README §10.2)
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

const { spawnSync } = require('node:child_process'),
  { PACKAGES, isNewer, npmBin, npmInstallGlobal } = require('@andrian.yablonskyy/thub-common'),
  { version } = require('../package.json');

// npm's output goes to stderr so a command's own stdout (e.g. JSON a CI
// script parses) stays clean.
const NPM_STDIO = ['inherit', 2, 2],
  CHECK_TIMEOUT_MS = 5000;

// Tries a plain `npm i -g` first (nvm, a user-owned prefix, or root in
// CI); if that fails on an interactive terminal, retries through sudo
// for a system-wide install. Never throws — returns whether it worked.
function installAgent(target){
  try {
    if (npmInstallGlobal(PACKAGES.agent, target, { stdio: NPM_STDIO }) === 0){
      return true;
    }
    if (process.getuid?.() !== 0 && process.stdin.isTTY){
      console.error('thub: retrying with sudo');
      return spawnSync('sudo', [npmBin(), 'i', '-g', `${PACKAGES.agent}@${target}`], { stdio: NPM_STDIO }).status === 0;
    }
  }
  catch (err){
    console.error(`thub: self-update failed: ${err.message}`);
  }
  return false;
}

// Runs before every command that talks to the Coordinator. If an admin
// requested an update (Agents page) and it's newer than this Agent,
// installs it and re-runs the same command line on the new version. Any
// failure — Coordinator unreachable, no permission to install — just
// falls through to running the command on the current version.
async function applyRequestedUpdate(api){
  if (process.env.THUB_NO_SELF_UPDATE || process.env.THUB_SELF_UPDATED){
    return;
  }
  let updateTo;
  try {
    ({ updateTo } = await api.get('/agents/me/update', { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }));
  }
  catch {
    return; // older Coordinator, or unreachable — the command reports that itself
  }
  if (!isNewer(updateTo, version)){
    return;
  }

  console.error(`thub: updating v${version} -> v${updateTo} (requested by the Coordinator)`);
  if (!installAgent(updateTo)){
    console.error(`thub: update failed — continuing on v${version}. To update by hand: sudo npm i -g ${PACKAGES.agent}@${updateTo}`);
    return;
  }
  const rerun = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, THUB_SELF_UPDATED: '1' }
  });
  process.exit(rerun.status ?? 1);
}

module.exports = { applyRequestedUpdate, installAgent, version };
