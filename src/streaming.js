'use strict';

const { exitCodeForJobState, EXIT_CODES } = require('@thub/shared');

/**
 * Streams a job's logs until it reaches a terminal state, or the user
 * hits Ctrl-C. Reconnects with exponential backoff and resumes from the
 * last seen `seq` on network drops (§7).
 *
 * In --wait mode (used by CI, §11) Ctrl-C/SIGINT is treated as a cancel
 * request; otherwise it only detaches and the job keeps running.
 */
async function followJob(client, jobId, { fromSeq = 0, waitMode = false, print = console.log } = {}) {
  let lastEventId = fromSeq;
  let finished = false;
  let backoffMs = 500;
  const controller = new AbortController();

  const onSigint = async () => {
    if (finished) return;
    finished = true;
    controller.abort();
    if (waitMode) {
      print('\nReceived cancel signal — canceling job...');
      try {
        await client.post(`/jobs/${jobId}/cancel`);
      } catch {
        // best effort — the process is exiting either way
      }
      resolveOnce(EXIT_CODES.CANCELED);
    } else {
      print(`\nDetached. Job keeps running.\nthub status ${jobId}`);
      resolveOnce(EXIT_CODES.DETACHED);
    }
  };

  let resolveOnce;
  const done = new Promise((resolve) => {
    resolveOnce = (code) => {
      finished = true;
      resolve(code);
    };
  });

  process.on('SIGINT', onSigint);

  (async () => {
    while (!finished) {
      try {
        await client.streamEvents(`/jobs/${jobId}/logs/stream`, {
          lastEventId,
          signal: controller.signal,
          onEvent: ({ event, id, data }) => {
            if (id) lastEventId = id;
            if (event === 'log') {
              print(`[${data.stream}] ${data.line}`);
            } else if (event === 'state') {
              print(`-- ${data.state}${data.resource ? ' on ' + data.resource : ''} --`);
            } else if (event === 'end') {
              print(`\nJob finished: ${data.state}`);
              if (data.artifactsUrl) print(`Artifacts: ${data.artifactsUrl}`);
              resolveOnce(exitCodeForJobState(data.state));
            }
          },
        });
        if (!finished) {
          // Server closed the stream without an `end` event (rare) — retry.
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 10_000);
        }
      } catch (err) {
        if (controller.signal.aborted) break;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10_000);
      }
    }
  })();

  try {
    return await done;
  } finally {
    process.off('SIGINT', onSigint);
    controller.abort();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { followJob };
