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

const { Command } = require('commander'),
  { ApiClient, EXIT_CODES, ACTIVE_JOB_STATES, exitCodeForJobState, PACKAGES, fetchLatestVersion, isNewer, isValidVersion } =
    require('@andrian.yablonskyy/thub-common'),
  { resolveConnection, resolveGroup, resolveUser, writeConfigFile, readConfigFile } = require('./config'),
  { parseDurationSec } = require('./duration'),
  { followJob } = require('./streaming'),
  { applyRequestedUpdate, installAgent, version } = require('./self-update');

const program = new Command();
program
  .name('thub')
  .description('TestHub Agent — submit test jobs and follow them, from CI or your laptop')
  .option('--url <url>', 'Coordinator URL (overrides THUB_URL / config file)')
  .option('--token <token>', 'Agent token (overrides THUB_TOKEN / config file)')
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

function fail(err){
  console.error(`Error: ${err.message}`);
  process.exit(err.status && Number.isInteger(err.status) && err.status < 100 ? err.status : EXIT_CODES.USAGE);
}

program
  .command('run')
  .description('Submit a test job and follow its log')
  .requiredOption('--type <hw|sw>', 'Required resource type')
  .option('--board <name>', 'Shorthand for --label board:<name>')
  .option('--label <label>', 'Required label the resource must have (repeatable)', collectRepeatable, [])
  .option(
    '--group <groupId>',
    'Restrict scheduling to resources that are members of this group (§13.1). ' +
      'Overrides THUB_GROUP / config file; leave unset for an unconstrained run.'
  )
  .option(
    '--user <name>',
    'Free-text job owner, shown on the Client and the dashboard to tell whose job is whose ' +
      '— purely a label, not an identity. Overrides THUB_USER / config file.'
  )
  .requiredOption('--image <url>', 'Firmware/build image URL (Artifactory or a Docker registry blob) fetched by the Client')
  .option('--sha256 <hex>', 'Expected sha256 of --image; the Client verifies it before flashing/running')
  .requiredOption('--tests <url>', 'Test package URL in Artifactory')
  .option('--suite <name>', 'Test suite name', 'default')
  .option('--arg <value>', 'Extra argument passed through to run-tests.sh on the Client (repeatable)', collectRepeatable, [])
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
  .option('--source <ci|cli>', 'Override auto-detected job source')
  .option(
    '--dry-run',
    'Exercise the full pipeline (schedule, accept, state transitions, logs, artifact, result) ' +
      'without the Client flashing/running anything for real',
    false
  )
  .action(async (opts) => {
    try {
      const c = client(),
        source = opts.source || (process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'cli'),
        labels = [...(opts.board ? [`board:${opts.board}`] : []), ...opts.label],
        meta = Object.fromEntries(opts.meta.map((kv) => kv.split(/=(.*)/s).slice(0, 2))),
        group = resolveGroup({ group: opts.group }),
        user = resolveUser({ user: opts.user }),

        spec = {
          target: { type: opts.type, labels, ...(group ? { group } : {}) },
          firmware: { url: opts.image, ...(opts.sha256 ? { sha256: opts.sha256 } : {}) },
          tests: { url: opts.tests, suite: opts.suite, args: opts.arg },
          timeoutSec: parseDurationSec(opts.timeout),
          priority: opts.priority ?? (source === 'ci' ? 50 : 60),
          source,
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
  .description('Show status; follow log if running, show artifacts if done')
  .argument('<jobId>')
  .option('--json', 'Machine-readable output', false)
  .action(async (jobId, opts) => {
    try {
      const c = client(),
        job = await c.get(`/jobs/${jobId}`);
      if (opts.json && !ACTIVE_JOB_STATES.has(job.state)){
        console.log(JSON.stringify(job));
        return process.exit(exitCodeForJobState(job.state));
      }

      console.log(`Job ${job.id} — ${job.state}${job.resource ? ' on ' + job.resource.name : ''}`);
      console.log(`Created: ${job.created_at}`);

      if (ACTIVE_JOB_STATES.has(job.state)){
        const code = await followJob(c, jobId, { fromSeq: 0, waitMode: false });
        return process.exit(code);
      }

      const { artifacts } = await c.get(`/jobs/${jobId}/artifacts`);
      console.log(`Verdict: ${job.state}`);
      for (const a of artifacts){
        console.log(`  ${a.name}  ${a.url}`);
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
  .option('--mine', 'Only jobs submitted by this agent token', false)
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
        ['CREATED', (j) => j.created_at]
      ]);
    }
    catch (err){
      fail(err);
    }
  });

const config = program.command('config').description('Manage local Agent configuration');
config
  .command('set')
  .argument('<key>', 'url | token | group | user')
  .argument('<value>')
  .action((key, value) => {
    if (!['url', 'token', 'group', 'user'].includes(key)){
      console.error('Error: key must be "url", "token", "group", or "user"');
      process.exit(EXIT_CODES.USAGE);
    }
    const current = readConfigFile();
    writeConfigFile({ ...current, [key]: value });
    console.log(`Saved ${key} to config`);
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
