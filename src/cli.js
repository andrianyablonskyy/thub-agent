#!/usr/bin/env node

/**
 * @file        packages/agent/src/cli.js
 * @description thub CLI entry point: run/status/cancel/resources/jobs/config commands (README §7)
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

const { Command, Option } = require('commander'),
  {
    ApiClient, EXIT_CODES, ACTIVE_JOB_STATES, exitCodeForJobState, PACKAGES, fetchLatestVersion, isNewer, isValidVersion, formatDateTime,
    splitArgs,
    parseEnvList
  } = require('@andrian.yablonskyy/thub-common'),
  { resolveConnection, resolveUser, writeConfigFile, readConfigFile, CONFIG_PATH } = require('./config'),
  { parseDurationSec } = require('./duration'),
  { followJob } = require('./streaming'),
  { applyRequestedUpdate, installAgent, version } = require('./self-update');

const program = new Command();
program
  .name('thub')
  .description('TestHub Agent — submit test jobs and follow them, from CI or your laptop')
  .option('--url <url>', 'Coordinator URL (overrides THUB_URL / config file)')
  .option('--key <key>', 'Your access key (overrides THUB_KEY / config file)')
  .addOption(new Option('--token <token>', 'Old name of --key').hideHelp())
  .version(version);

// An admin-requested self-update (README §10.2) is applied at the start of
// the next run of any command that talks to the Coordinator.
const NO_UPDATE_CHECK = new Set(['config', 'set', 'check-update', 'self-update']);
program.hook('preAction', async (thisCommand, actionCommand) => {
  if (NO_UPDATE_CHECK.has(actionCommand.name())){
    return;
  }
  let api;
  try {
    api = client();
  }
  catch {
    return; // not configured — the command itself reports that
  }
  await applyRequestedUpdate(api);
});

function client(){
  const { url, token } = resolveConnection(program.opts());
  return new ApiClient({ baseUrl: url, token, userAgent: `thub-agent/${version}` });
}

// --command (mandatory), --download-file (repeatable), --docker-image (SW
// only) and --git-repo <url> [ref] --depth <n> -> the job spec's task fields.
// Checked here too, so mistakes explain themselves before anything is sent.
function taskFromOptions(opts){
  const downloads = opts.downloadFile.map((url) => {
      if (!/^https?:\/\//i.test(url)){
        throw usageError(`--download-file ${url}: must be an http(s) URL`);
      }
      return { url };
    }),
    task = { command: opts.command, args: opts.arg, suite: opts.suite, ...(downloads.length ? { downloads } : {}) };

  if (opts.dockerImage){
    if (opts.type !== 'sw'){
      throw usageError('--docker-image only works for SW jobs (--type sw): an HW job runs on the physical board');
    }
    task.image = opts.dockerImage;
  }

  if (opts.depth !== undefined && !opts.gitRepo){
    throw usageError('--depth only applies to --git-repo');
  }
  if (opts.gitOptions !== undefined && !opts.gitRepo){
    throw usageError('--git-options only applies to --git-repo');
  }
  if (opts.gitOptions){
    try {
      splitArgs(opts.gitOptions);
    }
    catch (err){
      throw usageError(`--git-options: ${err.message}`);
    }
  }
  if (opts.gitRepo){
    const [url, ref, ...extra] = opts.gitRepo;
    if (extra.length){
      throw usageError(`--git-repo takes a URL and at most one branch, tag or commit (got: ${opts.gitRepo.join(' ')})`);
    }
    const depth = opts.depth === undefined ? 1 : Number(opts.depth);
    if (!Number.isInteger(depth) || depth < 0){
      throw usageError(`--depth ${opts.depth}: must be a whole number (0 = full history)`);
    }
    task.git = { url, ...(ref ? { ref } : {}), depth, ...(opts.gitOptions ? { options: opts.gitOptions } : {}) };
  }
  let env;
  try {
    env = parseEnvList(opts.env);
  }
  catch (err){
    throw usageError(err.message);
  }
  if (Object.keys(env).length){
    task.env = env;
  }
  return task;
}

function usageError(message){
  return Object.assign(new Error(message), { status: EXIT_CODES.USAGE });
}

function fail(err){
  console.error(`Error: ${err.message}`);
  // The Coordinator validates the spec with its own thub-common: an unknown
  // field means it's older than this Agent.
  if (/Invalid job spec.*must NOT have additional properties/.test(err.message)){
    let url = 'the configured URL';
    try {
      ({ url } = resolveConnection(program.opts()));
    }
    catch { /* keep the generic wording */ }
    console.error(`Hint: the Coordinator at ${url} doesn't know an option ` +
      `this Agent (v${version}) sent — update the Coordinator (dashboard → Update app, or npm i -g @andrian.yablonskyy/thub-coordinator@latest).`);
  }
  process.exit(err.status && Number.isInteger(err.status) && err.status < 100 ? err.status : EXIT_CODES.USAGE);
}

program
  .command('run')
  .description('Submit a test job and follow its log')
  .requiredOption('--type <hw|sw>', 'Required resource type')
  .option('--board <name>', 'Shorthand for --label board:<name>')
  .option('--label <label>', 'Required label the resource must have (repeatable)', collectRepeatable, [])
  .option(
    '--client <nameOrId>',
    'Run on this specific Client (resource name or id) only; the job waits in that Client\'s queue ' +
      'even if other matching resources are idle.'
  )
  .option(
    '--user <name>',
    'Free-text job owner, shown on the Client and the dashboard to tell whose job is whose ' +
      '— purely a label, not an identity. Overrides THUB_USER / config file.'
  )
  .requiredOption(
    '--command <string>',
    'The task\'s entry point: a shell command the Client runs (sh -c) in the task\'s work directory — the --git-repo ' +
      'checkout if given — after downloading --download-file files. --arg values arrive as "$@"'
  )
  .option(
    '--download-file <url>',
    'A file the Client downloads into the work directory before running --command (repeatable; http/https). ' +
      'Paths are passed as THUB_DOWNLOAD_1.. / THUB_DOWNLOADS_DIR',
    collectRepeatable,
    []
  )
  .option(
    '--docker-image <name>',
    'SW jobs only: a Docker image the Client runs as the job\'s DUT container, next to --command (e.g. registry.lab:5000/emu:1); ' +
      'pulled from the registry it names, else Docker Hub. Without it, an SW job has no DUT container'
  )
  .option(
    '--git-repo <url...>',
    'A git repository the Client clones before running --command, then runs it there: <url> [<branch>|<tag>|<commit>] ' +
      '(https://, ssh://, git:// or user@host:path; default ref: the default branch)'
  )
  .option('--depth <n>', 'With --git-repo: how many commits to fetch (default 1; 0 = full history)')
  .option(
    '--git-options <string>',
    'With --git-repo: extra git options, placed between `git` and its subcommand on the Client (shell-quoted, no shell run), ' +
      'e.g. \'-c core.sshCommand="ssh -i ~/.ssh/lab_key -p 2222"\'. Stored with the job — reference key files, don\'t inline secrets'
  )
  .option(
    '--env <vars>',
    'Environment variables for every command the Client runs for the job (git, --command): ' +
      'NAME=value[,NAME=value] (repeatable; a value may contain commas); --env NAME alone takes its value from this shell. ' +
      'Any names (except THUB_*, JOB_*, GIT_TERMINAL_PROMPT, GIT_ALLOW_PROTOCOL). ' +
      'Values reach only the Client running the job; the Coordinator masks them and drops them when the job ends',
    collectRepeatable,
    []
  )
  .option('--suite <name>', 'Test suite name, passed to --command as THUB_SUITE', 'default')
  .option('--arg <value>', 'Extra argument for --command, as "$@" (repeatable)', collectRepeatable, [])
  .option('--timeout <duration>', 'e.g. 30m, 1h', '30m')
  .option('--priority <n>', 'Priority 0-100', (v) => Number(v))
  .option('--wait', 'Do not detach on job end; exit with the verdict code (used in CI)', false)
  .option('--detach', 'Print the job id and exit immediately', false)
  .option('--json', 'Machine-readable output', false)
  .option(
    '--meta <keyValue>',
    'Extra metadata key=value, stored on the job and returned by `thub status --json` (repeatable). ' +
      'Use this to carry CI job ids, git repo/branch/sha/tag, or anything else you want attached to the run.',
    collectRepeatable,
    []
  )
  .option(
    '--dry-run',
    'Exercise the full pipeline (schedule, accept, state transitions, logs, result) ' +
      'without the Client flashing/running anything for real',
    false
  )
  .action(async (opts) => {
    try {
      const task = taskFromOptions(opts),
        c = client(),
        labels = [...(opts.board ? [`board:${opts.board}`] : []), ...opts.label],
        meta = Object.fromEntries(opts.meta.map((kv) => kv.split(/=(.*)/s).slice(0, 2))),
        user = resolveUser({ user: opts.user }),

        spec = {
          // No group: the Coordinator uses this key's, set on the dashboard (§13.1).
          target: { type: opts.type, labels, ...(opts.client ? { client: opts.client } : {}) },
          ...task,
          timeoutSec: parseDurationSec(opts.timeout),
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          ...(user ? { user } : {}),
          ...(Object.keys(meta).length ? { meta } : {}),
          ...(opts.dryRun ? { dryRun: true } : {})
        },

        result = await c.post('/jobs', spec);
      if (opts.json){
        console.log(JSON.stringify(result));
      }
      else {
        console.log(`Job ${result.jobId} queued`);
      }

      if (opts.detach){
        return process.exit(0);
      }

      const code = await followJob(c, result.jobId, { waitMode: opts.wait });
      process.exit(code);
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('status')
  .description('Show status; follow log if running, verdict, test counts and artifacts if done')
  .argument('<jobId>')
  .option('--json', 'Print the job as JSON once, without following it; exit code: its verdict, or 5 while it\'s still active', false)
  .action(async (jobId, opts) => {
    try {
      const c = client(),
        job = await c.get(`/jobs/${jobId}`);
      // --json never follows: a script polls it, and tells "still running"
      // (exit 5) from a verdict.
      if (opts.json){
        console.log(JSON.stringify(job));
        return process.exit(ACTIVE_JOB_STATES.has(job.state) ? EXIT_CODES.ACTIVE : exitCodeForJobState(job.state));
      }

      console.log(`Job ${job.id} — ${job.state}${job.resource ? ' on ' + job.resource.name : ''}`);
      console.log(`Created: ${formatDateTime(job.created_at)}`);

      if (ACTIVE_JOB_STATES.has(job.state)){
        const code = await followJob(c, jobId, { fromSeq: 0, waitMode: false });
        return process.exit(code);
      }

      console.log(`Verdict: ${job.state}${job.exit_code != null ? ` (exit code ${job.exit_code})` : ''}`);
      const s = job.summary;
      if (s && Number.isFinite(s.total) && s.total > 0){
        console.log(`Tests: ${s.total} total, ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
      }
      if (job.message){
        console.log(`Message: ${job.message}`);
      }
      // What the job published elsewhere and reported (links, not files).
      if (job.artifacts?.length){
        console.log('Artifacts:');
        for (const a of job.artifacts){
          console.log(`  ${a.name}  ${a.size != null ? formatBytes(a.size) : '—'}  ${a.link}`);
        }
      }
      process.exit(exitCodeForJobState(job.state));
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('cancel')
  .description('Cancel a job')
  .argument('<jobId>')
  .action(async (jobId) => {
    try {
      const job = await client().post(`/jobs/${jobId}/cancel`);
      console.log(`Job ${job.id} -> ${job.state}`);
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('resources')
  .description('List resources and their status')
  .option('--json', 'Machine-readable output', false)
  .action(async (opts) => {
    try {
      const { resources } = await client().get('/resources');
      if (opts.json){
        return console.log(JSON.stringify(resources));
      }
      printTable(resources, [
        ['NAME', (r) => r.name],
        ['TYPE', (r) => r.type],
        ['STATUS', (r) => r.status],
        ['BUSY', (r) => r.busySource || '-'],
        ['LABELS', (r) => r.labels.join(',')],
        ['LAST HEARTBEAT', (r) => r.lastHeartbeatAt || 'never']
      ]);
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('jobs')
  .description('List recent jobs')
  .option('--mine', 'Only jobs submitted by this agent token (always so for a cli token, which sees only its own)', false)
  .option('--state <state>', 'Filter by state')
  .option('--json', 'Machine-readable output', false)
  .action(async (opts) => {
    try {
      const { jobs } = await client().get('/jobs', { query: { mine: opts.mine, state: opts.state } });
      if (opts.json){
        return console.log(JSON.stringify(jobs));
      }
      printTable(jobs, [
        ['ID', (j) => j.id],
        ['SOURCE', (j) => j.source],
        ['USER', (j) => j.spec.user || '-'],
        ['STATE', (j) => j.state],
        ['CREATED', (j) => formatDateTime(j.created_at)]
      ]);
    }
    catch (err){
      fail(err);
    }
  });

// 1233 -> "1.2 KB" (1024-based), for artifact sizes.
function formatBytes(bytes){
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1){
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const config = program.command('config').description('Manage local Agent configuration');
config
  .command('set')
  .argument('<name>', 'url | key | user')
  .argument('<value>')
  .action((name, value) => {
    // `token` is the old name of `key`.
    const setting = name === 'token' ? 'key' : name;
    if (!['url', 'key', 'user'].includes(setting)){
      console.error(setting === 'group'
        ? 'Error: a job\'s group is set on the dashboard now (Users / CI tokens), not in the Agent'
        : 'Error: the setting must be "url", "key", or "user"');
      process.exit(EXIT_CODES.USAGE);
    }
    const { token: _old, ...current } = readConfigFile();
    writeConfigFile({ ...(setting === 'key' ? current : { ...current, ...(_old ? { token: _old } : {}) }), [setting]: value });
    console.log(`Saved ${setting} to config`);
  });

// Who this access key belongs to (§10.3).
function describeMe(me){
  const role = me.user?.role ? me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1) : '',
    who = me.user ? `${me.user.username} (${role})${me.user.email ? ` <${me.user.email}>` : ''}` : `CI token "${me.name}"`;
  // Older Coordinators don't say: then nothing about groups.
  return me.group === undefined ? who : `${who}\nJobs run in: ${me.group ? `group ${me.group}` : 'any resource (no group)'}`;
}

program
  .command('whoami')
  .description('Show whose access key this Agent uses')
  .action(async () => {
    try {
      console.log(describeMe(await client().get('/me')));
    }
    catch (err){
      fail(err);
    }
  });

const keyCommand = program.command('key').description('Your access key');
keyCommand
  .command('show')
  .description('Show your access key\'s details (never the key itself — only its last characters)')
  .action(async () => {
    try {
      const me = await client().get('/me'),
        { keySource } = resolveConnection(program.opts());
      console.log(`User:      ${describeMe(me)}`);
      if (me.key){
        console.log(`Key:       …${me.key.hint || '????'} (from ${keySource === 'file' ? CONFIG_PATH : keySource === 'flag' ? '--key' : keySource})`);
        console.log(`Created:   ${formatDateTime(me.key.createdAt)}`);
        console.log(`Last used: ${me.key.lastUsedAt ? formatDateTime(me.key.lastUsedAt) : 'never'}`);
      }
    }
    catch (err){
      fail(err);
    }
  });
keyCommand
  .command('rotate')
  .description('Replace your access key: the current one stops working at once')
  .action(async () => {
    try {
      const { keySource } = resolveConnection(program.opts()),
        { key, username } = await client().post('/me/key/rotate');
      if (keySource === 'file'){
        const { token: _old, ...current } = readConfigFile();
        writeConfigFile({ ...current, key });
        console.log(`New access key for ${username} saved to ${CONFIG_PATH} — the old one has stopped working.`);
      }
      else {
        console.log(`New access key for ${username} — the old one has stopped working. Shown only now:\n\n  ${key}\n`);
        console.log(keySource === 'flag'
          ? 'Use it with --key from now on (or save it: thub config set key <key>).'
          : `Update ${keySource} (e.g. your CI secret) with it, or save it: thub config set key <key>.`);
      }
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('check-update')
  .description('Compare this Agent with the latest published version')
  .action(async () => {
    try {
      const latest = await fetchLatestVersion(PACKAGES.agent);
      console.log(`Installed: v${version}  Latest: v${latest}`);
      console.log(isNewer(latest, version) ? 'Update available: thub self-update' : 'Up to date.');
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('self-update')
  .description('Update this Agent to the latest (or a given) version with npm i -g')
  .option('--to <x.y.z>', 'Install this version instead of the latest')
  .action(async (opts) => {
    try {
      const target = opts.to || await fetchLatestVersion(PACKAGES.agent);
      if (!isValidVersion(target)){
        throw new Error(`Invalid version "${target}"`);
      }
      if (!opts.to && !isNewer(target, version)){
        console.log(`Already on v${version}.`);
        return;
      }
      console.log(`Updating v${version} -> v${target}`);
      process.exit(installAgent(target) ? 0 : 1);
    }
    catch (err){
      fail(err);
    }
  });

function collectRepeatable(value, previous){
  return [...previous, value];
}

function printTable(rows, columns){
  if (rows.length === 0){
    console.log('(none)');
    return;
  }
  const widths = columns.map(([header], i) => Math.max(header.length, ...rows.map((r) => String(columns[i][1](r)).length))),
    line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(columns.map(([h]) => h)));
  for (const row of rows){
    console.log(line(columns.map(([, f]) => f(row))));
  }
}

program.parseAsync(process.argv);
