# Release notes — @andrian.yablonskyy/thub-agent

What changed in each release, newest first. `## Unreleased` collects the changes since the version on npm; `bin/publish` turns that heading into the version and date it releases.

## 1.1.24 — 2026-10-16

### Added

- **`thub connect --json` streams NDJSON events** for tools such as the VS Code extension. The first line is `{"event": "ready", …}`: the same object as before, with `event` added, so existing readers still work. Then there's one line per change:
  - `status` (`waiting` / `ready`, with the reservation's end);
  - `disconnected` (retry delay, reason) and `connected` (`again`);
  - `video` (the camera streams, or why not);
  - `fatal` (e.g. *The reservation ended*), just before it exits.

  The human messages still go to stderr.
- **`thub whoami --json`**: whose key it is (`kind`, `user` or `name`, `group`), as the Agent API's `/me` returns it.

## 1.1.23 — 2026-10-15

### Changed

- Requires thub-common 2.2.4.

## 1.1.22 — 2026-10-15

### Changed

- **`thub connect` shows the camera's state.** The Video line says whether the board's camera is streaming, and if not, why, for example `(not streaming — ffmpeg isn't installed on this Client host …)`. Each change is printed as it happens (`Video: streaming`, `Video: not streaming — …`), with no viewer needed. Needs Client 1.1.26.

## 1.1.21 — 2026-10-15

### Fixed

- **`thub connect` and `thub console` behind a proxy without WebSocket support** stop with the reason instead of retrying forever: *The Coordinator answered HTTP 302 → /login instead of opening a WebSocket: a reverse proxy in front of the Coordinator isn't passing WebSocket upgrades …* The same goes for `426` (Coordinator 1.1.41). Other refusals (`401`, `403`, `404`, `409`) were already final.

## 1.1.20 — 2026-10-15

### Added

- **`thub reserve <client> [--for <dur>]`** holds a runner for your own jobs (README §5.5).
  - **Duration:** whole minutes (`30m`, `2h`; 1 h by default), up to the runner's maximum. Running it again extends the reservation from now.
  - **Output:** the end time, how to use the runner, and the reservation's own remote access link.
  - **Release:** **`thub release <client>`** ends it; maintainers and admins can end anyone's.
- **`thub resources`** has a RESERVED column (who, until when). With `--json`, each runner has its `reservation`, and for your own reservation its `id` and `link`.
- **`thub connect <client>`** keeps a live connection to your reserved board (README §5.6) and prints that reservation's link and a local port per device:
  - **UARTs:** `127.0.0.1:5001` and up (`--uart-port`), for socat, picocom or pyserial's `socket://`.
  - **ST-Links:** a GDB port each, `127.0.0.1:3333` and up (`--gdb-port`). Each connection starts its own OpenOCD on the Client; `--target <name>` gives the OpenOCD target.
  - **Camera:** if the board has one (README §5.7), `http://127.0.0.1:8090/<reservation id>/video.ts` (`--video-port`) for VLC, ffplay or mpv. The URL is that reservation's own. `--video-udp <port>` also sends it as UDP.
  - **Reconnecting:** it reconnects by itself (1 s, 2 s … 30 s). Serial terminals and video viewers stay connected through a reconnect; GDB has to connect again.
  - **Exiting:** it exits with the reason when the reservation ends.
  - **Options:** `--bind` and `--json`.
- **`thub console <client> [--uart <n>]`** puts one UART of your reserved board in the terminal. Ctrl-] quits.
- New dependency: `ws` 8.21.3.

### Changed

- Requires thub-common 2.2.3.

## 1.1.19 — 2026-10-14

### Changed

- Requires thub-common 2.2.2.

## 1.1.18 — 2026-10-13

### Changed

- Requires thub-common 2.2.1.

## 1.1.14 — 2026-10-09

### Removed

- **`--token`, `THUB_TOKEN` and the config file's `token`.** Use `--key`, `THUB_KEY` and `key`; `thub config set` accepts `url` and `key` only.
- The unused `PLATFORMS` export of `report.js`.

## 1.1.13 — 2026-10-09

Changes since 1.1.12.

### Changed

- **Back on npm.** Install with `npm i -g @andrian.yablonskyy/thub-agent`. `check-update`, `self-update` and dashboard-requested updates use npm again, and require thub-common from npm. The git-based updates in the versions released only as git tags (1.1.11–1.1.12) are gone. An install of one of those updates from git tags, which are still pushed with every release, so it keeps updating.

## 1.1.12 — 2026-10-08

Changes since 1.1.11.

### Changed

- **Updates come from the Agent's git repository.** `thub check-update` reads its newest release tag. `thub self-update` and an update requested on the dashboard install with `npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-agent.git#vX.Y.Z`, retrying with sudo on a terminal.
- **Install:** `npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-agent.git`, or in CI `npx -y --package='git+https://github.com/andrianyablonskyy/thub-agent.git#semver:*' thub …`.

### Upgrading from npm

- An Agent installed from npm (1.1.10 or older) can only update from npm, where nothing new comes: reinstall it once from git with the command above.

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
