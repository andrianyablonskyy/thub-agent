#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { ApiClient, EXIT_CODES, ACTIVE_JOB_STATES, exitCodeForJobState } = require('@thub/shared');
const { resolveConnection, writeConfigFile, readConfigFile } = require('./config');
const { parseDurationSec } = require('./duration');
const { followJob } = require('./streaming');

const program = new Command();
program
  .name('thub')
  .description('TestHub Agent — submit test jobs and follow them, from CI or your laptop')
  .option('--url <url>', 'Coordinator URL (overrides THUB_URL / config file)')
  .option('--token <token>', 'Agent token (overrides THUB_TOKEN / config file)');

function client() {
  const { url, token } = resolveConnection(program.opts());
  return new ApiClient({ baseUrl: url, token });
}

function fail(err) {
  console.error(`Error: ${err.message}`);
  process.exit(err.status && Number.isInteger(err.status) && err.status < 100 ? err.status : EXIT_CODES.USAGE);
}

program
  .command('run')
  .description('Submit a test job and follow its log')
  .requiredOption('--type <hw|sw>', 'Required resource type')
  .option('--board <name>', 'Shorthand for --label board:<name>')
  .option('--label <label>', 'Required label the resource must have (repeatable)', collectRepeatable, [])
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
  .action(async (opts) => {
    try {
      const c = client();
      const source = opts.source || (process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'cli');
      const labels = [...(opts.board ? [`board:${opts.board}`] : []), ...opts.label];
      const meta = Object.fromEntries(opts.meta.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));

      const spec = {
        target: { type: opts.type, labels },
        firmware: { url: opts.image, ...(opts.sha256 ? { sha256: opts.sha256 } : {}) },
        tests: { url: opts.tests, suite: opts.suite, args: opts.arg },
        timeoutSec: parseDurationSec(opts.timeout),
        priority: opts.priority ?? (source === 'ci' ? 50 : 60),
        source,
        ...(Object.keys(meta).length ? { meta } : {}),
      };

      const result = await c.post('/jobs', spec);
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`Job ${result.jobId} queued`);

      if (opts.detach) return process.exit(0);

      const code = await followJob(c, result.jobId, { waitMode: opts.wait });
      process.exit(code);
    } catch (err) {
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
      const c = client();
      const job = await c.get(`/jobs/${jobId}`);
      if (opts.json && !ACTIVE_JOB_STATES.has(job.state)) {
        console.log(JSON.stringify(job));
        return process.exit(exitCodeForJobState(job.state));
      }

      console.log(`Job ${job.id} — ${job.state}${job.resource ? ' on ' + job.resource.name : ''}`);
      console.log(`Created: ${job.created_at}`);

      if (ACTIVE_JOB_STATES.has(job.state)) {
        const code = await followJob(c, jobId, { fromSeq: 0, waitMode: false });
        return process.exit(code);
      }

      const { artifacts } = await c.get(`/jobs/${jobId}/artifacts`);
      console.log(`Verdict: ${job.state}`);
      for (const a of artifacts) console.log(`  ${a.name}  ${a.url}`);
      process.exit(exitCodeForJobState(job.state));
    } catch (err) {
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
    } catch (err) {
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
      if (opts.json) return console.log(JSON.stringify(resources));
      printTable(resources, [
        ['NAME', (r) => r.name],
        ['TYPE', (r) => r.type],
        ['STATUS', (r) => r.status],
        ['BUSY', (r) => r.busySource || '-'],
        ['LABELS', (r) => r.labels.join(',')],
        ['LAST HEARTBEAT', (r) => r.lastHeartbeatAt || 'never'],
      ]);
    } catch (err) {
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
      if (opts.json) return console.log(JSON.stringify(jobs));
      printTable(jobs, [
        ['ID', (j) => j.id],
        ['SOURCE', (j) => j.source],
        ['STATE', (j) => j.state],
        ['CREATED', (j) => j.created_at],
      ]);
    } catch (err) {
      fail(err);
    }
  });

const config = program.command('config').description('Manage local Agent configuration');
config
  .command('set')
  .argument('<key>', 'url | token')
  .argument('<value>')
  .action((key, value) => {
    if (!['url', 'token'].includes(key)) {
      console.error('Error: key must be "url" or "token"');
      process.exit(EXIT_CODES.USAGE);
    }
    const current = readConfigFile();
    writeConfigFile({ ...current, [key]: value });
    console.log(`Saved ${key} to config`);
  });

function collectRepeatable(value, previous) {
  return [...previous, value];
}

function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const widths = columns.map(([header], i) => Math.max(header.length, ...rows.map((r) => String(columns[i][1](r)).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(columns.map(([h]) => h)));
  for (const row of rows) console.log(line(columns.map(([, f]) => f(row))));
}

program.parseAsync(process.argv);
