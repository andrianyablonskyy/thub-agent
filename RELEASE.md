# Release notes — @andrian.yablonskyy/thub-agent

What changed in each release, newest first. `## Unreleased` collects the changes since the version on npm; `bin/publish` turns that heading into the version and date it releases.

## 1.1.11 — 2026-10-08

Changes since 1.1.11.

### Changed

- **Not published to npm any more.** A release is its `vX.Y.Z` tag on GitHub. thub-common comes from its public repository by tag (`git+https://github.com/andrianyablonskyy/thub-common.git#semver:^…`), so installing needs `git` on the host. `package.json` has `"private": true`.

## 1.1.11 — 2026-10-08

Changes since 1.1.10.

### Changed

- When the Coordinator rejects an option this Agent sent (it's older), the hint says to update it with **Update app** on the dashboard or `thub-admin self-update` on its host. The Coordinator isn't on npm any more.

## 1.1.8 — 2026-10-08

Changes since 1.1.7.

### Requires

- `@andrian.yablonskyy/thub-common` 1.1.7 or later, released with this version (Client device lists of up to 16 entries, the UART `label`). The Agent itself works as in 1.1.7: nothing in its commands or output changed.

## 1.1.7 — 2026-10-08

Changes since 1.1.6.

### Added

- **`thub report <jobId>`**: a job's report as Markdown — verdict, board and Client, duration, test counts, the failed tests, links to the job's log and the CI run — or, with `--post gitlab|bitbucket|github`, **one sticky comment on the merge/pull request** of the pipeline, updated in place by every later run of the same CI job. `--commit-status` also sets a GitLab commit status, Bitbucket build status or GitHub status that links to the TestHub job. The project, merge/pull request, commit and pipeline come from the CI's own variables; it needs only the code host's token (`GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `GITHUB_TOKEN`). Every test case is listed when the job published its JUnit XML as an artifact (fetched with `--artifact-header`). Also `--title`, `--key`, `--pr`, `--commit`, `--run-url`, `--summary`, `--output`, `--exit-code`.
- **`thub run --id-file <path>`**: writes the job id to a file as soon as the job is queued, for a later `thub report` in the step that runs whatever the result.

### Changed

- With `--wait`, **`SIGTERM` cancels the job** like `SIGINT` (Ctrl-C) always did. GitLab CI, Jenkins and most CI runners stop a canceled step with `SIGTERM`, which used to end the Agent and leave the job holding the bench until its timeout. Without `--wait`, `SIGTERM` still just ends the Agent.

### Requires

- `@andrian.yablonskyy/thub-common` with `report-markdown` (the release after 1.1.5).

### Docs

- README: CI/CD for GitHub Actions (with the TestHub action), GitLab, Bitbucket and Jenkins; merge/pull-request comments; test frameworks (GoogleTest, CTest, pytest, JUnit) and their results in the PR comment; artifact storage and authentication (Artifactory, S3, Google Drive, SFTP, certificates); the license is now `LICENSE.md` (`"license"` and `"author"` set in `package.json`).
- These release notes (`RELEASE.md`) are now part of the package.
