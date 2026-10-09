/**
 * @file        packages/agent/src/report.js
 * @description thub report: a finished job as Markdown, posted as a sticky comment on a GitLab merge request, a
 *              Bitbucket pull request or a GitHub pull request, with an optional commit/build status (README §11.5)
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
  crypto = require('node:crypto'),
  { parseJUnit, renderComment, renderSummary, commentMarker, statusFor, countsFromCases } = require('@andrian.yablonskyy/thub-common');

const JUNIT_MAX_FILES = 10,
  JUNIT_MAX_BYTES = 5 * 1024 * 1024;

function fail(message, status = 1){
  return Object.assign(new Error(message), { status });
}

async function http(method, url, { headers = {}, body } = {}){
  const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'thub-agent', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    }),
    data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok){
    const why = data?.message || data?.error?.message || data?.error || '';
    throw fail(`${method} ${url.replace(/\?.*/, '')}: HTTP ${res.status}${why ? ` ${typeof why === 'string' ? why : JSON.stringify(why)}` : ''}`);
  }
  return data;
}

// ---- Where the report goes ------------------------------------------------
// Each platform: what it reads from its own CI's environment, how it finds
// and updates its comment, and how it sets a commit status.

const PLATFORMS = {
  // GitLab merge requests. GITLAB_TOKEN: a project (or group) access token
  // with the api scope, Reporter or above; CI_JOB_TOKEN can't write notes.
  gitlab: {
    detect(env, opts){
      const api = (env.CI_API_V4_URL || '').replace(/\/+$/, ''),
        project = env.CI_PROJECT_ID,
        token = env.GITLAB_TOKEN;
      if (!api || !project){
        throw fail('--post gitlab: CI_API_V4_URL and CI_PROJECT_ID are not set — run it in a GitLab CI job', 4);
      }
      if (!token){
        throw fail('--post gitlab: set GITLAB_TOKEN (a project access token with the api scope) as a masked CI/CD variable', 4);
      }
      return {
        api,
        base: `${api}/projects/${encodeURIComponent(project)}`,
        headers: { 'PRIVATE-TOKEN': token },
        target: opts.pr || env.CI_MERGE_REQUEST_IID || null,
        sha: opts.commit || env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA || null,
        runUrl: env.CI_PIPELINE_URL || null,
        runLabel: 'Pipeline',
        key: env.CI_JOB_NAME || null
      };
    },
    // A branch pipeline has no CI_MERGE_REQUEST_IID: the open MR for the commit.
    async findTarget(p){
      if (p.target || !p.sha){
        return p.target;
      }
      const mrs = await http('GET', `${p.base}/repository/commits/${p.sha}/merge_requests`, { headers: p.headers });
      return mrs.find((mr) => mr.state === 'opened')?.iid || null;
    },
    async upsert(p, mr, marker, body){
      const notes = `${p.base}/merge_requests/${mr}/notes`;
      for (let page = 1; page <= 20; page++){
        const list = await http('GET', `${notes}?per_page=100&page=${page}&sort=asc`, { headers: p.headers }),
          own = list.find((n) => n.body?.startsWith(marker));
        if (own){
          await http('PUT', `${notes}/${own.id}`, { headers: p.headers, body: { body } });
          return 'updated';
        }
        if (list.length < 100){
          break;
        }
      }
      await http('POST', notes, { headers: p.headers, body: { body } });
      return 'created';
    },
    status(p, { state, context, description, url }){
      return http('POST', `${p.base}/statuses/${p.sha}`, {
        headers: p.headers, body: { state, name: context, description: description.slice(0, 255), target_url: url }
      });
    },
    targetName: (mr) => `merge request !${mr}`
  },

  // Bitbucket Cloud pull requests. BITBUCKET_TOKEN: a repository access token
  // with Pull requests: Write (and Repositories: Write for the build status);
  // or BITBUCKET_AUTH=user:app-password / email:API-token, as basic auth.
  bitbucket: {
    detect(env, opts){
      const ws = env.BITBUCKET_WORKSPACE,
        repo = env.BITBUCKET_REPO_SLUG,
        api = (env.BITBUCKET_API_URL || 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
      if (!ws || !repo){
        throw fail('--post bitbucket: BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG are not set — run it in a Bitbucket Pipelines step', 4);
      }
      const auth = env.BITBUCKET_TOKEN
        ? `Bearer ${env.BITBUCKET_TOKEN}`
        : env.BITBUCKET_AUTH ? `Basic ${Buffer.from(env.BITBUCKET_AUTH).toString('base64')}` : null;
      if (!auth){
        throw fail('--post bitbucket: set BITBUCKET_TOKEN (a repository access token) or BITBUCKET_AUTH=user:password as a secured variable', 4);
      }
      return {
        base: `${api}/repositories/${ws}/${repo}`,
        headers: { Authorization: auth },
        target: opts.pr || env.BITBUCKET_PR_ID || null,
        sha: opts.commit || env.BITBUCKET_COMMIT || null,
        runUrl: env.BITBUCKET_GIT_HTTP_ORIGIN && env.BITBUCKET_BUILD_NUMBER
          ? `${env.BITBUCKET_GIT_HTTP_ORIGIN}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}` : null,
        runLabel: 'Pipeline',
        key: null
      };
    },
    // Only pull-request pipelines (pull-requests:) carry BITBUCKET_PR_ID.
    findTarget: async (p) => p.target,
    async upsert(p, pr, marker, body){
      let url = `${p.base}/pullrequests/${pr}/comments?pagelen=100`;
      for (let page = 0; url && page < 20; page++){
        const list = await http('GET', url, { headers: p.headers }),
          own = (list.values || []).find((c) => !c.deleted && c.content?.raw?.startsWith(marker));
        if (own){
          await http('PUT', `${p.base}/pullrequests/${pr}/comments/${own.id}`, { headers: p.headers, body: { content: { raw: body } } });
          return 'updated';
        }
        url = list.next;
      }
      await http('POST', `${p.base}/pullrequests/${pr}/comments`, { headers: p.headers, body: { content: { raw: body } } });
      return 'created';
    },
    // A build status key is at most 40 characters: a hash of ours.
    status(p, { state, context, description, url }){
      return http('POST', `${p.base}/commit/${p.sha}/statuses/build`, {
        headers: p.headers,
        body: {
          key: `thub-${crypto.createHash('sha1').update(context).digest('hex').slice(0, 34)}`,
          state, name: context, description: description.slice(0, 255), url
        }
      });
    },
    targetName: (pr) => `pull request #${pr}`
  },

  // GitHub pull requests from any CI (Jenkins, …); in GitHub Actions the
  // TestHub action does this too. GITHUB_TOKEN: pull-requests (and statuses) write.
  github: {
    detect(env, opts){
      const repo = env.GITHUB_REPOSITORY,
        token = env.GITHUB_TOKEN;
      if (!repo){
        throw fail('--post github: set GITHUB_REPOSITORY (owner/name)', 4);
      }
      if (!token){
        throw fail('--post github: set GITHUB_TOKEN (pull-requests: write, and statuses: write for --commit-status)', 4);
      }
      let event = {};
      try {
        event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
      }
      catch { /* not in Actions */ }
      const server = env.GITHUB_SERVER_URL || 'https://github.com';
      return {
        base: `${(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')}/repos/${repo}`,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        target: opts.pr || event.pull_request?.number || null,
        sha: opts.commit || event.pull_request?.head?.sha || env.GITHUB_SHA || null,
        runUrl: env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null,
        runLabel: 'Workflow run',
        key: [env.GITHUB_WORKFLOW, env.GITHUB_JOB].filter(Boolean).join(' / ') || null
      };
    },
    findTarget: async (p) => p.target,
    async upsert(p, pr, marker, body){
      for (let page = 1; page <= 20; page++){
        const list = await http('GET', `${p.base}/issues/${pr}/comments?per_page=100&page=${page}`, { headers: p.headers }),
          own = list.find((c) => c.body?.startsWith(marker));
        if (own){
          await http('PATCH', `${p.base}/issues/comments/${own.id}`, { headers: p.headers, body: { body } });
          return 'updated';
        }
        if (list.length < 100){
          break;
        }
      }
      await http('POST', `${p.base}/issues/${pr}/comments`, { headers: p.headers, body: { body } });
      return 'created';
    },
    status(p, { state, context, description, url }){
      return http('POST', `${p.base}/statuses/${p.sha}`, {
        headers: p.headers, body: { state, context, description: description.slice(0, 140), target_url: url }
      });
    },
    targetName: (pr) => `pull request #${pr}`
  }
};

// Test cases from the JUnit XML the job listed in $THUB_ARTIFACTS_FILE.
async function junitCases(job, headerLines, warn){
  const headers = Object.fromEntries(headerLines.map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()])),
    files = (job.artifacts || []).filter((a) => /\.xml(\?|$)/i.test(a.name || '') || /\.xml(\?|$)/i.test(a.link || '')).slice(0, JUNIT_MAX_FILES),
    cases = [];
  for (const a of files){
    try {
      const res = await fetch(a.link, { headers });
      if (!res.ok){
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      if (text.length > JUNIT_MAX_BYTES){
        throw new Error('larger than 5 MB');
      }
      cases.push(...parseJUnit(text));
    }
    catch (err){
      warn(`Couldn't read test results from ${a.name}: ${err.message} (--artifact-header, if the storage needs credentials)`);
    }
  }
  return cases;
}

// `thub report <jobId>`. `api`: the Agent's ApiClient; `baseUrl`: the
// Coordinator, for the job page's link. Returns { markdown, posted, status }.
async function report(api, baseUrl, jobId, opts, { env = process.env, out = console.log, warn = console.error } = {}){
  for (const h of opts.artifactHeader || []){
    if (!/^[A-Za-z0-9-]+:\s*\S/.test(h)){
      throw fail(`--artifact-header ${h}: expected "Name: value"`, 4);
    }
  }
  if (opts.post && !PLATFORMS[opts.post]){
    throw fail(`--post ${opts.post}: must be gitlab, bitbucket or github`, 4);
  }
  if (opts.commitStatus && !opts.post){
    throw fail('--commit-status needs --post gitlab|bitbucket|github (where to set it)', 4);
  }
  const job = await api.get(`/jobs/${encodeURIComponent(jobId)}`),
    cases = opts.junit === false ? [] : await junitCases(job, opts.artifactHeader || [], warn);
  if (cases.length && !(job.summary?.total > 0)){
    job.summary = { ...job.summary, ...countsFromCases(cases) };
  }
  const platform = opts.post ? PLATFORMS[opts.post] : null,
    where = platform ? platform.detect(env, opts) : {},
    flavor = opts.flavor || opts.post || 'github',
    key = opts.key || [where.key, opts.title].filter(Boolean).join(' / ') || 'TestHub',
    ctx = {
      key,
      title: opts.title,
      flavor,
      jobUrl: `${baseUrl.replace(/\/+$/, '')}/jobs/${job.id}`,
      runUrl: opts.runUrl || where.runUrl || null,
      runLabel: opts.runLabel || where.runLabel || 'CI run',
      sha: opts.commit || where.sha || null
    },
    markdown = opts.summary ? renderSummary(job, ctx, cases) : renderComment(job, ctx, cases),
    result = { job, markdown, posted: null, status: null };

  if (opts.output){
    fs.writeFileSync(opts.output, markdown + '\n');
  }
  if (!platform){
    if (!opts.output){
      out(markdown);
    }
    return result;
  }

  const target = await platform.findTarget(where);
  if (target){
    const action = await platform.upsert(where, target, commentMarker(key, flavor), renderComment(job, ctx, cases));
    result.posted = { target, action };
    out(`${platform.targetName(target)}: TestHub comment ${action}`);
  }
  else {
    const what = opts.post === 'gitlab' ? 'merge request' : 'pull request';
    warn(`No ${what} for this pipeline — nothing commented (use a ${what} pipeline, or --pr <number>)`);
  }
  if (opts.commitStatus){
    if (!where.sha){
      throw fail('--commit-status: no commit (set --commit <sha>)', 4);
    }
    const state = statusFor(job.state, opts.post),
      description = `${job.state}${job.summary?.total ? ` — ${job.summary.passed}/${job.summary.total} tests passed` : ''}` +
        `${job.resource?.name ? ` on ${job.resource.name}` : ''}`;
    await platform.status(where, { state, context: `TestHub / ${key}`, description, url: ctx.jobUrl });
    result.status = state;
    out(`commit ${where.sha.slice(0, 7)}: status ${state}`);
  }
  return result;
}

module.exports = { report };
