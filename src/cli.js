#!/usr/bin/env node

/**
 * @file        packages/agent/src/cli.js
 * @description thub CLI entry point: run/status/cancel/power/report/resources/reserve/release/connect/console/jobs/config commands (README §7)
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
  {
    ApiClient, EXIT_CODES, ACTIVE_JOB_STATES, exitCodeForJobState, PACKAGES, fetchLatestVersion, isNewer, isValidVersion, formatDateTime,
    parseEnvList, POWER_ACTIONS, DEFAULT_RESET_DELAY_SEC, MAX_RESET_DELAY_SEC, powerRequestErrors, OPENOCD_TARGET_RE
  } = require('@andrian.yablonskyy/thub-common'),
  { RemoteSession, listenLocal, serveVideo } = require('./remote'),
  { resolveConnection, writeConfigFile, readConfigFile, CONFIG_PATH } = require('./config'),
  { parseDurationSec } = require('./duration'),
  { followJob } = require('./streaming'),
  { applyRequestedUpdate, installAgent, version } = require('./self-update'),
  { report } = require('./report'),
  fs = require('node:fs');

const program = new Command();
program
  .name('thub')
  .description('TestHub Agent — submit test jobs and follow them, from CI or your laptop')
  .option('--url <url>', 'Coordinator URL (overrides THUB_URL / config file)')
  .option('--key <key>', 'Your access key (overrides THUB_KEY / config file)')
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

// --command (mandatory), --download-file (repeatable) and --env -> the job
// spec's task fields. A git checkout or a container is the command's own job.
// Checked here too, so mistakes explain themselves before anything is sent.
function taskFromOptions(opts){
  const downloads = opts.downloadFile.map((url) => {
      if (!/^https?:\/\//i.test(url)){
        throw usageError(`--download-file ${url}: must be an http(s) URL`);
      }
      return { url };
    }),
    task = { command: opts.command, args: opts.arg, suite: opts.suite, ...(downloads.length ? { downloads } : {}) };

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

// --power-on-start / --power-on-end / --power-reset-delay -> the job spec's
// `power` (README §8.7), checked here so a typo fails before it's sent.
function powerFromOptions(opts){
  const power = {};
  for (const [option, key]of [['powerOnStart', 'onStart'], ['powerOnEnd', 'onEnd']]){
    if (opts[option] !== undefined){
      if (!POWER_ACTIONS.includes(opts[option])){
        throw usageError(`--${option.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} ${opts[option]}: must be one of ${POWER_ACTIONS.join(', ')}`);
      }
      power[key] = opts[option];
    }
  }
  if (opts.powerResetDelay !== undefined){
    const errors = powerRequestErrors({ action: 'reset', delaySec: opts.powerResetDelay });
    if (errors.length){
      throw usageError(`--power-reset-delay: ${errors.join('; ')}`);
    }
    if (power.onStart !== 'reset' && power.onEnd !== 'reset'){
      throw usageError('--power-reset-delay needs --power-on-start reset or --power-on-end reset');
    }
    power.resetDelaySec = opts.powerResetDelay;
  }
  if (Object.keys(power).length && opts.type !== 'hw'){
    throw usageError('--power-on-start / --power-on-end are for HW jobs only (--type hw)');
  }
  return Object.keys(power).length ? power : null;
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
      `this Agent (v${version}) sent — update the Coordinator (dashboard → Update app, or on its host: thub-admin self-update).`);
  }
  process.exit(err.status && Number.isInteger(err.status) && err.status < 100 ? err.status : EXIT_CODES.USAGE);
}

// --label: the labels a runner must all have for the job (§7.1).
// Checked here against the Coordinator's rule, so a typo fails before the
// job is sent.
const LABEL_RE = /^[^\s,;]{1,64}$/;
function requiredLabels(opts){
  const labels = opts.label,
    bad = labels.filter((l) => !LABEL_RE.test(l));
  if (bad.length){
    const err = new Error(`Invalid label: ${bad.join(', ')} — 1–64 characters, no spaces, commas or semicolons`);
    err.status = EXIT_CODES.USAGE;
    throw err;
  }
  return [...new Set(labels)];
}

program
  .command('run')
  .description('Submit a test job and follow its log')
  .requiredOption('--type <hw|sw>', 'Required resource type')
  .option('--label <label>', 'A label the runner must have (repeatable; the job runs only on a runner with all of them). ' +
    '1–64 characters, no spaces, commas or semicolons', collectRepeatable, [])
  .option(
    '--client <nameOrId>',
    'Run on this specific Client (resource name or id) only; the job waits in that Client\'s queue ' +
      'even if other matching resources are idle.'
  )
  .requiredOption(
    '--command <string>',
    'The task\'s entry point: a shell command the Client runs (sh -c) in the job\'s work directory, after downloading ' +
      '--download-file files. --arg values arrive as "$@". Anything else the job needs it does itself — e.g. ' +
      '`git clone "https://x-access-token:$GH_TOKEN@github.com/org/tests.git" src && cd src && ./ci/test.sh` or ' +
      '`docker run --rm "$IMAGE" ./run.sh` — with credentials passed by --env'
  )
  .option(
    '--download-file <url>',
    'A file the Client downloads into the work directory before running --command (repeatable; http/https). ' +
      'Paths are passed as THUB_DOWNLOAD_1.. / THUB_DOWNLOADS_DIR',
    collectRepeatable,
    []
  )
  .option(
    '--env <vars>',
    'Environment variables for --command — how data and secrets (a git token, a registry password) reach the job: ' +
      'NAME=value[,NAME=value] (repeatable; a value may contain commas); --env NAME alone takes its value from this shell. ' +
      'Any names except THUB_* and JOB_*. ' +
      'Values reach only the Client running the job; the Coordinator masks them and drops them when the job ends',
    collectRepeatable,
    []
  )
  .option('--suite <name>', 'Test suite name, passed to --command as JOB_SUITE', 'default')
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
  .option('--power-on-start <action>', `USB power on the Client (uhubctl) before the DUT is prepared: ${POWER_ACTIONS.join(' | ')} (HW only)`)
  .option('--power-on-end <action>', `USB power on the Client when the job ends, whatever its verdict: ${POWER_ACTIONS.join(' | ')} (HW only)`)
  .option('--id-file <path>', 'Write the job id to this file as soon as it\'s queued (for a later `thub report`, §11.5)')
  .option('--power-reset-delay <sec>', `Seconds a reset keeps the power off (default ${DEFAULT_RESET_DELAY_SEC}, max ${MAX_RESET_DELAY_SEC})`, (v) => Number(v))
  .action(async (opts) => {
    try {
      const task = taskFromOptions(opts),
        power = powerFromOptions(opts),
        c = client(),
        labels = requiredLabels(opts),
        meta = Object.fromEntries(opts.meta.map((kv) => kv.split(/=(.*)/s).slice(0, 2))),

        spec = {
          // No group or user: the Coordinator takes both from this key (§13.1).
          target: { type: opts.type, labels, ...(opts.client ? { client: opts.client } : {}) },
          ...task,
          timeoutSec: parseDurationSec(opts.timeout),
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          ...(Object.keys(meta).length ? { meta } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
          ...(power ? { power } : {})
        },

        result = await c.post('/jobs', spec);
      if (opts.idFile){
        fs.writeFileSync(opts.idFile, `${result.jobId}\n`);
      }
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

// README §8.7: the owner of a running job switches its Client's USB power
// right away — no need to wait for the job to end or to cancel it.
program
  .command('power')
  .description('Switch the USB power of the Client running your job (uhubctl): on, off or reset — while it runs')
  .argument('<action>', POWER_ACTIONS.join(' | '))
  .argument('<jobId>')
  .option('--delay <sec>', `reset: seconds the power stays off (default ${DEFAULT_RESET_DELAY_SEC}, max ${MAX_RESET_DELAY_SEC})`, (v) => Number(v))
  .option('--port <n>', 'Only this port of the Client: its number in the Client\'s hw-devices.usbPower.ports (default: all of them)', (v) => Number(v))
  .option('--json', 'Machine-readable output', false)
  .action(async (action, jobId, opts) => {
    try {
      const errors = powerRequestErrors({ action, delaySec: opts.delay, port: opts.port });
      if (errors.length){
        throw usageError(errors.join('; ').replace('the reset delay (delaySec)', '--delay').replace(/^port/, '--port'));
      }
      const res = await client().post(`/jobs/${jobId}/power`, {
        action, ...(opts.delay !== undefined ? { delaySec: opts.delay } : {}), ...(opts.port !== undefined ? { port: opts.port } : {})
      });
      if (opts.json){
        return console.log(JSON.stringify(res));
      }
      const what = `USB power ${res.action}${res.port ? ` (port ${res.port})` : ''}${res.action === 'reset' ? `, ${res.delaySec} s off` : ''}`;
      console.log(`${what} sent to ${res.resource.name} for job ${res.jobId} — the job's log shows when it's done.`);
    }
    catch (err){
      fail(err);
    }
  });

// §11.5: the job as Markdown, or posted where its code is reviewed — the
// same report the GitHub Action leaves, from any CI.
program
  .command('report')
  .description('A job\'s report as Markdown, or a sticky comment on a GitLab merge request / Bitbucket or GitHub pull request')
  .argument('<jobId>', 'The job, e.g. A-00042 (thub run --id-file saves it)')
  .option('--post <platform>', 'Comment on the merge/pull request of this pipeline: gitlab, bitbucket or github (from the CI\'s own variables)')
  .option('--commit-status', 'With --post: also set a commit status (GitLab) / build status (Bitbucket) / status (GitHub) linking to the job', false)
  .option('--title <text>', 'A title in the heading, e.g. "HW smoke (nucleo-f401re)"')
  .option('--key <text>', 'What identifies the comment, so the next run updates it (default: the CI job name and --title)')
  .option('--pr <number>', 'The merge/pull request, when the pipeline doesn\'t say (a branch pipeline)')
  .option('--commit <sha>', 'The commit to report on and set the status of (default: the pipeline\'s)')
  .option('--run-url <url>', 'A link back to the CI run (default: the pipeline\'s)')
  .option('--run-label <text>', 'Its label (default: Pipeline / Workflow run)')
  .option('--flavor <platform>', 'Without --post: Markdown for github (default), gitlab or bitbucket (no HTML)')
  .option('--summary', 'The full report (every test, artifacts) instead of the comment', false)
  .option('--artifact-header <header>', 'A "Name: value" header for fetching the JUnit XML the job listed as artifacts (repeatable)', collectRepeatable, [])
  .option('--no-junit', 'Don\'t fetch the JUnit XML artifacts (counts only)')
  .option('--output <file>', 'Write the Markdown to this file (default: print it, unless --post)')
  .option('--exit-code', 'Exit with the job\'s verdict code (0 PASSED, 1 FAILED, …) instead of 0', false)
  .action(async (jobId, opts) => {
    try {
      const { url } = resolveConnection(program.opts()),
        { job } = await report(client(), url, jobId, opts);
      if (opts.exitCode){
        process.exit(ACTIVE_JOB_STATES.has(job.state) ? EXIT_CODES.ACTIVE : exitCodeForJobState(job.state));
      }
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
        ['RESERVED', (r) => (r.reservation ? `${r.reservation.by} until ${formatDateTime(r.reservation.until)}` : '-')],
        ['LAST HEARTBEAT', (r) => r.lastHeartbeatAt || 'never']
      ]);
    }
    catch (err){
      fail(err);
    }
  });

// README §5.5: hold a runner for your own jobs for a while — everyone
// else's go elsewhere or wait — and give it back, or let the time run out.
program
  .command('reserve')
  .description('Reserve a runner for your own jobs, for a while: until then only your jobs run on it')
  .argument('<client>', 'The runner\'s name or id (thub resources)')
  .option('--for <duration>', 'How long, e.g. 30m, 2h (default 1h; at most what the runner allows). Again on your own: extends it from now')
  .option('--json', 'Machine-readable output', false)
  .action(async (name, opts) => {
    try {
      let minutes;
      if (opts.for !== undefined){
        const sec = parseDurationSec(opts.for);
        if (!sec || sec % 60){
          throw usageError(`--for must be whole minutes, e.g. 30m or 2h (got "${opts.for}")`);
        }
        minutes = sec / 60;
      }
      const r = await client().post(`/resources/${encodeURIComponent(name)}/reserve`, minutes ? { minutes } : {});
      if (opts.json){
        return console.log(JSON.stringify(r));
      }
      console.log(`${r.name} is reserved for you until ${formatDateTime(r.reservation.until)}.\n` +
        `Only your jobs run on it (thub run --client ${r.name} …); thub release ${r.name} when you're done.\n` +
        `Its UARTs and SWD: thub connect ${r.name} (local ports), thub console ${r.name} (serial in this terminal).` +
        (r.reservation.link ? `\nThis reservation's link: ${r.reservation.link}` : ''));
    }
    catch (err){
      fail(err);
    }
  });

program
  .command('release')
  .description('End your reservation of a runner (maintainers: anyone\'s) — everyone\'s jobs can run on it again')
  .argument('<client>', 'The runner\'s name or id')
  .option('--json', 'Machine-readable output', false)
  .action(async (name, opts) => {
    try {
      const r = await client().post(`/resources/${encodeURIComponent(name)}/release`);
      if (opts.json){
        return console.log(JSON.stringify(r));
      }
      console.log(r.released ? `${r.name} released.` : `${r.name} wasn't reserved.`);
    }
    catch (err){
      fail(err);
    }
  });

// README §5.6: the reserved board's UARTs and SWD, live from the Client
// through the Coordinator — `thub connect` on local TCP ports for any tool
// (GDB, socat, pyserial), `thub console` right in this terminal. Both make
// a dropped connection again by themselves, until the reservation ends.
// Each reservation has its own link (README §5.6): the one you hold now.
// A later reservation of the same runner is a new link — run this again.
async function remoteSession(name){
  const { token } = resolveConnection(program.opts()),
    { resources } = await client().get('/resources'),
    r = resources.find((x) => x.name === name || x.id === name);
  if (!r){
    throw usageError(`Unknown client "${name}" (thub resources lists them)`);
  }
  if (!r.reservation?.link){
    throw usageError(r.reservation
      ? `${r.name} is reserved by ${r.reservation.by} — only their reservation's link connects`
      : `${r.name} isn't reserved — thub reserve ${r.name} first`);
  }
  return new RemoteSession({ url: r.reservation.link, token, client: r.name, userAgent: `thub-agent/${version}` });
}

function onRemoteTrouble(session, log, cleanup){
  session.on('status', (s) => s.state === 'waiting' &&
    log(`Waiting for ${s.client}'s Client to connect — it does within a heartbeat of the reservation…`));
  session.on('disconnected', ({ retryMs, reason }) =>
    log(`Connection lost${reason ? ` (${reason})` : ''} — reconnecting in ${Math.max(1, Math.round(retryMs / 1000))} s…`));
  session.on('connected', ({ again }) => again && log('Reconnected.'));
  session.on('fatal', (message) => {
    cleanup();
    fail(Object.assign(new Error(message), { status: EXIT_CODES.USAGE }));
  });
}

program
  .command('connect')
  .description('Share your reserved board\'s UARTs and SWD (GDB via OpenOCD) on local TCP ports, over a live connection that reconnects by itself')
  .argument('<client>', 'The runner you reserved (thub reserve)')
  .option('--target <name>', 'OpenOCD target for SWD, e.g. stm32f4x (target/<name>.cfg; default: the probe\'s openocdTarget on the Client)')
  .option('--uart-port <port>', 'Local port of UART 1 (UART n: this + n - 1)', (v) => Number(v), 5001)
  .option('--gdb-port <port>', 'Local GDB port of ST-Link 1 (ST-Link n: this + n - 1)', (v) => Number(v), 3333)
  .option('--bind <address>', 'Local address to listen on (another than loopback shares the board with your network)', '127.0.0.1')
  .option('--video-port <port>', 'Local HTTP port of the board\'s USB camera stream, if it has one', (v) => Number(v), 8090)
  .option('--video-udp <port>', 'Also send the camera stream as UDP (MPEG-TS) to this local port, e.g. 5600', (v) => Number(v))
  .option('--json', 'Print the ports as JSON once connected', false)
  .action(async (name, opts) => {
    try {
      if (opts.target !== undefined && !OPENOCD_TARGET_RE.test(opts.target)){
        throw usageError(`--target must be an OpenOCD target script name such as stm32f4x (got "${opts.target}")`);
      }
      for (const [flag, v]of [['--uart-port', opts.uartPort], ['--gdb-port', opts.gdbPort], ['--video-port', opts.videoPort],
        ...(opts.videoUdp !== undefined ? [['--video-udp', opts.videoUdp]] : [])]){
        if (!Number.isInteger(v) || v < 0 || v > 65535){
          throw usageError(`${flag} must be a port number`);
        }
      }
      const session = await remoteSession(name),
        log = (m) => console.error(m);
      let listening = null,
        until = null;
      const cleanup = () => {
        session.stop();
        listening?.then(({ servers, video }) => {
          servers.forEach((srv) => srv.close());
          video?.close();
        }).catch(() => {});
      };
      onRemoteTrouble(session, log, cleanup);
      session.on('status', (s) => {
        until = s.until;
      });
      session.on('devices', (devices) => {
        if (listening){
          return;
        }
        listening = (async () => {
          const local = await listenLocal(session, devices, {
              host: opts.bind, uartBase: opts.uartPort, gdbBase: opts.gdbPort, target: opts.target, log
            }),
            // The camera (README §5.7) on a URL with this reservation's own id in it.
            video = devices.camera
              ? await serveVideo(session, {
                host: opts.bind, port: opts.videoPort, reservation: session.url.split('/').pop(), udpPort: opts.videoUdp, log
              })
              : null;
          return { ...local, video };
        })();
        listening
          .then(({ ports, video }) => printConnection(name, session.url, until, ports, devices, opts, video))
          .catch((err) => {
            cleanup();
            fail(usageError(err.code === 'EADDRINUSE'
              ? `Local port ${err.port} is in use — pick others with --uart-port / --gdb-port / --video-port`
              : `Can't listen locally: ${err.message}`));
          });
      });
      process.on('SIGINT', () => {
        cleanup();
        log(`Disconnected from ${name} (its reservation stays — thub release ${name} ends it).`);
        process.exit(0);
      });
      session.start();
    }
    catch (err){
      fail(err);
    }
  });

// The connection link and how to use each port.
function printConnection(name, link, until, ports, devices, opts, video){
  if (opts.json){
    return console.log(JSON.stringify({
      client: name, link, until, ports: ports.map((p) => ({ kind: p.kind, ...p.device, host: opts.bind, port: p.port })),
      video: video ? { camera: devices.camera.name, url: video.url, udp: video.udp } : null
    }));
  }
  const host = opts.bind === '0.0.0.0' || opts.bind === '::' ? 'localhost' : opts.bind,
    lines = [
      `Connected to ${name}${until ? ` — reserved until ${formatDateTime(until)} (thub release ${name} ends it)` : ''}`,
      `Link: ${link}`,
      ''
    ];
  for (const { kind, device: d, port }of ports){
    if (kind === 'uart'){
      lines.push(`UART ${d.index}  ${d.label}  ${d.baudRate} 8N1  tcp://${host}:${port}`,
        `        terminal: thub console ${name} --uart ${d.index}`,
        `        or: socat -,raw,echo=0 TCP:${host}:${port}  ·  pyserial: serial_for_url('socket://${host}:${port}')`);
    }
    else {
      const target = opts.target || d.target;
      lines.push(`SWD  ${d.index}  ${d.label}${d.serial ? ` (ST-Link ${d.serial})` : ''}  ` +
        `OpenOCD target ${target || '— none: add --target <name>'}  GDB: ${host}:${port}`,
      `        arm-none-eabi-gdb -ex "target extended-remote ${host}:${port}"   (each connection starts its own OpenOCD)`);
    }
  }
  if (video){
    lines.push(`Video   ${devices.camera.name}  H.264 (MPEG-TS)  ${video.url}`,
      `        vlc ${video.url}  ·  ffplay -fflags nobuffer ${video.url}` +
      (video.udp ? `\n        UDP: ${video.udp}  (ffplay -fflags nobuffer ${video.udp})` : '  ·  UDP too: --video-udp 5600'));
  }
  if (!ports.length && !video){
    lines.push(`${name} has no UARTs, ST-Links or camera.`);
  }
  if (devices.uarts.length && !devices.serial){
    lines.push('', 'UARTs won\'t open: the \'serialport\' package isn\'t installed on the Client host.');
  }
  lines.push('', 'Ctrl-C disconnects; a dropped connection is made again by itself.');
  console.log(lines.join('\n'));
}

program
  .command('console')
  .description('Your reserved board\'s UART in this terminal: its output here, your typing to the board. Ctrl-] quits')
  .argument('<client>', 'The runner you reserved (thub reserve)')
  .option('--uart <n>', 'Which UART (thub connect lists them)', (v) => Number(v), 1)
  .action(async (name, opts) => {
    try {
      const session = await remoteSession(name),
        log = (m) => process.stderr.write(`\r\n— ${m} —\r\n`),
        tty = process.stdin.isTTY;
      let ch = null;
      const restore = () => {
          if (tty){
            process.stdin.setRawMode(false);
          }
          process.stdin.pause();
        },
        cleanup = () => {
          session.stop();
          restore();
        },
        quit = (code = 0) => {
          cleanup();
          process.stderr.write(`\r\nDisconnected from ${name}.\r\n`);
          process.exit(code);
        };
      onRemoteTrouble(session, log, cleanup);
      session.on('devices', (devices) => {
        if (ch !== null){
          return;
        }
        const uart = devices.uarts.find((u) => u.index === opts.uart);
        if (!uart){
          cleanup();
          return fail(usageError(`${name} has no UART ${opts.uart} (it has ${devices.uarts.length})`));
        }
        process.stderr.write(`Connected to ${name} UART ${uart.index} (${uart.label}, ${uart.baudRate} 8N1). Ctrl-] quits.\r\n`);
        ch = session.open('uart', uart.index, {
          data: (buf) => process.stdout.write(buf),
          note: log,
          closed: (reason) => {
            log(reason);
            quit(EXIT_CODES.USAGE);
          }
        }, { persistent: true });
        if (tty){
          process.stdin.setRawMode(true);
        }
        process.stdin.on('data', (buf) => {
          if (buf.includes(0x1d)){
            return quit();
          }
          session.write(ch, buf);
        });
        process.stdin.resume();
      });
      process.on('SIGINT', () => quit());
      session.start();
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
  .argument('<name>', 'url | key')
  .argument('<value>')
  .action((name, value) => {
    if (!['url', 'key'].includes(name)){
      console.error('Error: the setting must be "url" or "key"');
      process.exit(EXIT_CODES.USAGE);
    }
    writeConfigFile({ ...readConfigFile(), [name]: value });
    console.log(`Saved ${name} to config`);
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
        writeConfigFile({ ...readConfigFile(), key });
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
