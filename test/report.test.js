/**
 * @file        packages/agent/test/report.test.js
 * @description Tests: thub report — the Markdown, and the sticky comment and commit/build status on GitLab, Bitbucket
 *              and GitHub (fake APIs)
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  { ApiClient } = require('@andrian.yablonskyy/thub-common'),
  { report } = require('../src/report');

const JUNIT = '<testsuite name="s"><testcase classname="uart" name="echo"/>' +
  '<testcase classname="uart" name="flow"><failure message="no CTS"/></testcase></testsuite>';

// The Coordinator (/api/v1/jobs/…), the JUnit artifact (/art/…) and the code
// host's API, on one server. `comments`: what the code host already has.
async function fake(t, { comments = [], state = 'FAILED' } = {}){
  const seen = [],
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        const json = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data)),
          u = req.url.replace(/\?.*/, '');
        if (u === '/api/v1/jobs/A-00042'){
          return json(200, {
            id: 'A-00042', state, exit_code: state === 'PASSED' ? 0 : 1, duration_sec: 75,
            created_at: '2026-10-08T10:00:00Z', started_at: '2026-10-08T10:00:30Z',
            resource: { name: 'lab-hw-01' }, spec: { suite: 'smoke', target: { labels: ['board:nucleo-f401re'] } },
            summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, artifacts: [{ name: 'junit.xml', link: `${base}/art/junit.xml` }]
          });
        }
        if (u === '/art/junit.xml'){
          return res.end(JUNIT);
        }
        if (req.method === 'GET' && u.endsWith('/merge_requests') && u.includes('/repository/commits/')){
          return json(200, [{ iid: 3, state: 'merged' }, { iid: 7, state: 'opened' }]);
        }
        if (req.method === 'GET'){
          return json(200, u.includes('/2.0/') ? { values: comments } : comments);
        }
        json(201, { id: 99 });
      });
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const api = new ApiClient({ baseUrl: base, token: 'agt_x' }),
    out = [],
    run = (opts, env) => report(api, 'https://thub.example.com', 'A-00042', opts, { env, out: (l) => out.push(l), warn: (l) => out.push(l) });
  return { base, seen, api, run, out };
}

test('without --post: the comment as Markdown, test counts from the JUnit artifact', async (t) => {
  const f = await fake(t),
    { markdown } = await f.run({ title: 'HW smoke' }, {});
  assert.match(markdown, /^<!-- thub-report:HW smoke -->\n### ❌ TestHub HW smoke: \*\*FAILED\*\*/);
  assert.match(markdown, /\| Board \| `nucleo-f401re` on lab-hw-01 \|/);
  assert.match(markdown, /\| Tests \| 2 total · 1 passed · 1 failed · 0 skipped \|/);
  assert.match(markdown, /\| Duration \| 1m 15s \(queued 30s\) \|/);
  assert.match(markdown, /\[A-00042\]\(https:\/\/thub\.example\.com\/jobs\/A-00042\)/);
  assert.match(markdown, /\| ❌ \| uart\.flow \| — \| no CTS \|/);
  assert.equal(f.out[0], markdown);
});

test('GitLab: finds the open MR of a branch pipeline, creates the note, sets the commit status', async (t) => {
  const f = await fake(t),
    env = {
      CI_API_V4_URL: `${f.base}/api/v4`, CI_PROJECT_ID: '12', GITLAB_TOKEN: 'glpat-x',
      CI_COMMIT_SHA: 'abc1234567', CI_PIPELINE_URL: 'https://gitlab.example.com/fw/-/pipelines/5', CI_JOB_NAME: 'test-hw'
    },
    { posted, status } = await f.run({ post: 'gitlab', commitStatus: true }, env);
  assert.deepEqual(posted, { target: 7, action: 'created' });
  const note = f.seen.find((r) => r.method === 'POST' && r.url === '/api/v4/projects/12/merge_requests/7/notes');
  assert.ok(note.body.body.startsWith('<!-- thub-report:test-hw -->'));
  assert.match(note.body.body, /\[Pipeline\]\(https:\/\/gitlab\.example\.com\/fw\/-\/pipelines\/5\)/);
  assert.match(note.body.body, /<details open><summary>Failed tests \(1\)<\/summary>/); // GitLab renders HTML
  assert.equal(note.headers['private-token'], 'glpat-x');
  const st = f.seen.find((r) => r.url === '/api/v4/projects/12/statuses/abc1234567');
  assert.deepEqual([st.body.state, st.body.name, st.body.target_url], ['failed', 'TestHub / test-hw', 'https://thub.example.com/jobs/A-00042']);
  assert.equal(status, 'failed');
});

test('GitLab: a merge-request pipeline updates its own note, leaving others alone', async (t) => {
  const f = await fake(t, { state: 'PASSED', comments: [{ id: 1, body: 'LGTM' }, { id: 2, body: '<!-- thub-report:test-hw -->\nold' }] }),
    env = { CI_API_V4_URL: 'x', CI_PROJECT_ID: '12', GITLAB_TOKEN: 't', CI_MERGE_REQUEST_IID: '4', CI_JOB_NAME: 'test-hw' };
  env.CI_API_V4_URL = `${f.base}/api/v4`;
  const { posted } = await f.run({ post: 'gitlab' }, env);
  assert.deepEqual(posted, { target: '4', action: 'updated' });
  const put = f.seen.find((r) => r.method === 'PUT');
  assert.equal(put.url, '/api/v4/projects/12/merge_requests/4/notes/2');
  assert.match(put.body.body, /✅ TestHub \*\*PASSED\*\*/);
});

test('Bitbucket: no HTML, a link-definition marker, the build status keyed under 40 characters', async (t) => {
  const f = await fake(t, { comments: [{ id: 5, content: { raw: '[//]: # (thub-report:HW smoke)\nold' } }] }),
    env = {
      BITBUCKET_API_URL: `${f.base}/2.0`, BITBUCKET_WORKSPACE: 'acme', BITBUCKET_REPO_SLUG: 'fw', BITBUCKET_PR_ID: '11',
      BITBUCKET_COMMIT: 'def4567890', BITBUCKET_TOKEN: 'bbtok', BITBUCKET_GIT_HTTP_ORIGIN: 'https://bitbucket.org/acme/fw', BITBUCKET_BUILD_NUMBER: '88'
    },
    { posted } = await f.run({ post: 'bitbucket', commitStatus: true, title: 'HW smoke' }, env);
  assert.deepEqual(posted, { target: '11', action: 'updated' });
  const put = f.seen.find((r) => r.method === 'PUT'),
    raw = put.body.content.raw;
  assert.equal(put.url, '/2.0/repositories/acme/fw/pullrequests/11/comments/5');
  assert.equal(put.headers.authorization, 'Bearer bbtok');
  assert.ok(raw.startsWith('[//]: # (thub-report:HW smoke)\n'));
  assert.doesNotMatch(raw, /<details|<sub>|<!--/);
  assert.match(raw, /\*\*Failed tests \(1\)\*\*/);
  assert.match(raw, /\[Pipeline\]\(https:\/\/bitbucket\.org\/acme\/fw\/pipelines\/results\/88\)/);
  const st = f.seen.find((r) => r.url === '/2.0/repositories/acme/fw/commit/def4567890/statuses/build');
  assert.equal(st.body.state, 'FAILED');
  assert.ok(st.body.key.length <= 40 && st.body.key.startsWith('thub-'));
  assert.equal(st.body.url, 'https://thub.example.com/jobs/A-00042');
});

test('GitHub from another CI (Jenkins): --pr and GITHUB_TOKEN', async (t) => {
  const f = await fake(t),
    env = { GITHUB_API_URL: f.base, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'ghp_x' },
    opts = { post: 'github', pr: '9', commit: 'aaa1111', commitStatus: true, runUrl: 'https://ci.lab/job/fw/12/', runLabel: 'Jenkins build' },
    { posted } = await f.run(opts, env);
  assert.deepEqual(posted, { target: '9', action: 'created' });
  const post = f.seen.find((r) => r.method === 'POST' && r.url === '/repos/o/r/issues/9/comments');
  assert.match(post.body.body, /\[Jenkins build\]\(https:\/\/ci\.lab\/job\/fw\/12\/\)/);
  assert.equal(f.seen.find((r) => r.url === '/repos/o/r/statuses/aaa1111').body.state, 'failure');
});

test('what\'s missing is said plainly', async (t) => {
  const f = await fake(t);
  await assert.rejects(f.run({ post: 'gitlab' }, { CI_API_V4_URL: 'x', CI_PROJECT_ID: '1' }), /set GITLAB_TOKEN/);
  await assert.rejects(f.run({ post: 'bitbucket' }, {}), /BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG are not set/);
  await assert.rejects(f.run({ post: 'gerrit' }, {}), /must be gitlab, bitbucket or github/);
  await assert.rejects(f.run({ commitStatus: true }, {}), /--commit-status needs --post/);
  // A Bitbucket branch pipeline: no PR to comment on, said so, not an error.
  f.out.length = 0;
  await f.run({ post: 'bitbucket' }, { BITBUCKET_API_URL: `${f.base}/2.0`, BITBUCKET_WORKSPACE: 'a', BITBUCKET_REPO_SLUG: 'b', BITBUCKET_TOKEN: 't' });
  assert.match(f.out.join('\n'), /No pull request for this pipeline/);
});
