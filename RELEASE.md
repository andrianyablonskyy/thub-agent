# Release notes — @andrian.yablonskyy/thub-agent

What changed in each release, newest first. `## Unreleased` collects the changes since the version on npm; `bin/publish` turns that heading into the version and date it releases.

## Unreleased

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
