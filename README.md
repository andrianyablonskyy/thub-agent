# @andrian.yablonskyy/thub-agent

The Agent CLI (`thub`) for [TestHub](https://github.com/andrianyablonskyy/thub) — a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. `thub` is the single entry point for both: it's stateless, everything it knows comes from the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) API, and it runs identically on a GitHub-hosted runner and a developer laptop — a developer reproducing a CI failure runs exactly the same command the pipeline runs.

See the [main TestHub repo](https://github.com/andrianyablonskyy/thub) for the full system architecture and how this fits with the Coordinator and the [Client](https://github.com/andrianyablonskyy/thub-client).

## Install

```bash
npm i -g @andrian.yablonskyy/thub-agent
# or, one-off in CI:
npx -y @andrian.yablonskyy/thub-agent run --type sw --download-file "$IMAGE_URL" --command ./ci/test.sh --wait
```

## Configuration

Read from flags (`--url`, `--key`), then environment (`THUB_URL`, `THUB_KEY`; the old names `--token`/`THUB_TOKEN` still work), then `~/.config/thub/agent.json`, then a bundled default. `url`/`token` are required by the time a command actually talks to the Coordinator; `group`/`user` are optional everywhere.

`npm install -g` creates `~/.config/thub/agent.json` for you (blank `url`/`token`, so nothing works until you set them) if it doesn't already exist — a re-install never overwrites it. Fill it in with `thub config set`:

```bash
thub config set url https://thub.example.com
thub config set key thk_...       # your access key: from an admin (Users), or your dashboard profile
thub whoami                       # jane (user) <jane@example.com>
thub key show                     # its last characters, created, last used
thub key rotate                   # a new key; the old one stops at once (saved here if it came from here)
```

## Commands

```
thub run      [options]        Submit a test job and follow its log
thub status   <jobId>          Show status; follow log if running, verdict, test counts and artifacts if done
thub cancel   <jobId>          Cancel a job
thub resources                 List resources and their status
thub jobs     [--mine] [--state <s>]   List recent jobs (a cli token: only its own; a ci token: all, or its own with --mine)
thub config   set <key> <value>        Save coordinator URL / key / default user locally
thub check-update                      Compare this Agent with the latest published version
thub self-update [--to <x.y.z>]        Update this Agent with npm i -g
thub --version
```

**Self-update.** An admin can request an update for this agent (or all agents) on the Coordinator's Agents page. The next command that talks to the Coordinator then installs it with `npm i -g` (retrying through `sudo` on an interactive terminal) and re-runs itself on the new version. If the install fails — e.g. no permission in CI — it prints the manual command and carries on with the current version; a run never fails because of an update. Set `THUB_NO_SELF_UPDATE=1` to opt out.

Key options for `thub run`. **On the Client** names the environment variable the job's command finds the option's value in (see *Client environment variables* below):

| Option | Description | On the Client |
|---|---|---|
| `--type hw\|sw` | Required resource type. | `JOB_TYPE` |
| `--label <l>` | Required labels (repeatable; a board is `--label board:<name>`): the job runs only on a runner that has all of them. Each 1–64 characters, no whitespace, commas or semicolons. | `JOB_LABEL`, `JOB_LABEL_<n>` |
| `--client <name\|id>` | Run on this specific Client (resource name or id) only; the job waits in that Client's queue even if other matching resources are idle. | `JOB_CLIENT` |
| `--command <string>` | **Required.** The task's entry point: a shell command the Client runs (`sh -c`) in the job's work directory, after the downloads. It clones repositories and runs containers itself (see Git and Docker below), with credentials from `--env`. Exit code 0 = PASSED. | `JOB_COMMAND` | `JOB_COMMAND` |
| `--download-file <url>` | A file the Client downloads before running the command (repeatable, `http(s)`), into the job's `downloads/` directory. | `JOB_DOWNLOAD_FILE`, `JOB_DOWNLOAD_FILE_<n>` (URLs); `THUB_DOWNLOAD_<n>` (local paths) |
| `--env <vars>` | Environment variables for every command the Client runs for the job (git and `--command`): `NAME=value[,NAME=value]`, repeatable; `--env NAME` alone takes the value from your shell. Any names — none means anything to the Agent or the Client (only `THUB_*`, `JOB_*`, `GIT_TERMINAL_PROMPT`, `GIT_ALLOW_PROTOCOL` are refused). Every value is a secret: it reaches only the Client running the job; the Coordinator masks it and drops it when the job ends. | each `NAME` itself |
| `--suite <name>` | Passed to the command as `THUB_SUITE`. | `JOB_SUITE` (also `THUB_SUITE`) |
| `--arg <value>` | Extra argument for the command, as `"$@"` (repeatable). | `JOB_ARG`, `JOB_ARG_<n>` (and `"$@"`) |
| `--timeout <dur>` | e.g. `30m`, default `30m`. | `JOB_TIMEOUT` (seconds) |
| `--priority <n>` | 0–100; CI defaults to 50, CLI to 60 so a developer is not starved by a busy pipeline. | `JOB_PRIORITY` |
| `--meta <key=value>` | Arbitrary metadata stored on the job (repeatable) — CI job ids, git coordinates, anything else worth attaching to the run. | `JOB_META_<KEY>` (also `THUB_META_<KEY>`) |
| `--dry-run` | Exercise the full pipeline without the Client executing anything for real. | — (the command doesn't run) |
| `--wait` | Do not detach on job end; exit with the job's verdict code (used in CI). | — (Agent only) |
| `--detach` | Print the job id and exit immediately. | — (Agent only) |
| `--json` | Machine-readable output. | — (Agent only) |

- `thub run` prints the **job ID**, then streams logs until Ctrl-C. Ctrl-C detaches; the job keeps running on the Client.
- `thub status <jobId>` prints the current state; if active it keeps streaming, if done it prints the verdict, the command's exit code and the JUnit test counts. `--json` prints the job once and never follows it (see [Job status and PASS/FAIL](#job-status-and-passfail)).

Exit codes make the Agent usable as a CI step:

| Code | Meaning |
|---|---|
| `0` | `PASSED` |
| `1` | `FAILED` |
| `2` | `ERROR`, `TIMEOUT`, or `LOST` |
| `3` | `CANCELED` |
| `4` | Usage, auth or connection error |
| `5` | `thub status <jobId> --json`: the job is still queued or running |
| `130` | Detached with Ctrl-C (job still running) |

## Examples

**Run a task** — download the firmware, clone the tests at a tag, flash and test (HW):

```bash
export GH_TOKEN=…   # read access to the tests repository
thub run --type hw --label board:nucleo-f401re \
  --download-file "$IMAGE_URL" --env GH_TOKEN \
  --command 'git clone --depth 1 --branch v1.4.0 "https://x-access-token:$GH_TOKEN@github.com/yourorg/firmware-tests.git" . &&
             st-flash --serial "$THUB_DUT_STLINK" --reset write "$THUB_DOWNLOAD_1" 0x08000000 && ./ci/test.sh "$@"' \
  --arg --junit --wait
```

**SW task against an emulator container of your own** (started and removed by the command):

```bash
thub run --type sw --download-file "$IMAGE_URL" \
  --command 'dut="thub-$THUB_JOB_ID" && trap "docker rm -f $dut >/dev/null" EXIT &&
             docker run -d --name "$dut" -p 127.0.0.1:5555:5555 -v "$THUB_DOWNLOADS_DIR:/downloads:ro" registry.lab.local:5000/dut-emulator:2026.08 &&
             make test DUT=127.0.0.1:5555' --wait
```

**Associate a CI/CD job id with the internal job id:**

```bash
thub run --type sw --download-file "$IMAGE_URL" --command ./ci/test.sh \
  --meta ciJobId="$GITHUB_RUN_ID" --wait
thub status A-00123 --json | jq '.spec.meta.ciJobId'
```

**Pass extra metadata** — `--meta key=value` reaches the command as `THUB_META_<KEY>` (`ciJobId` → `THUB_META_CI_JOB_ID`).

**Dry-run the pipeline** — proves the Coordinator↔Client plumbing works without real hardware or reachable downloads:

```bash
thub run --type sw --download-file https://does-not-exist.invalid/app.bin \
  --command ./ci/test.sh --dry-run --wait
```

**Run in a resource group:** there's no `--group` option. An admin or maintainer gives your user (or a CI token) one group on the dashboard, and every job it submits runs only on that group's resources; `thub whoami` shows it.

**Who submitted a job** comes from your key: your username (a CI token: its name), shown on the dashboard, in `thub jobs`, on the Client's console and as `JOB_USER`. There's no `--user`.

## Environment variables and secrets

`--env NAME=value[,NAME=value]` (repeatable) sets variables for `--command`. It's how all data and secrets reach a job (a git token, a registry password, an API key). The names are yours; none means anything to the Agent or the Client. `--env NAME` alone takes the value from your own environment, so a secret stays off the command line and out of CI logs:

```bash
export API_TOKEN=…
thub run --type sw \
  --env TARGET=staging --env API_TOKEN \
  --command './run-tests.sh --target "$TARGET"' --wait
```

**How the values are kept secret:**

- They reach **only the Client that runs the job**.
- The Agent API shows every value as `***`: `thub status --json`, `thub jobs --json`, even for your own job. The dashboard lists the names only.
- The Coordinator replaces the values with `***` once the job ends.
- A `--dry-run` shows every value as `***`, whatever its name.

Your command's output is the job's log, so don't print secrets. Everything else — `--command`, `--arg`, `--meta`, `--download-file` — is stored as is and visible, so never put secrets there.

## Git

The Client doesn't clone anything (and doesn't need git itself): the command does, into its work directory, with a token from `--env`:

```bash
export GH_TOKEN=…
thub run --type sw --env GH_TOKEN,REF=main \
  --command 'git clone --depth 1 --branch "$REF" "https://x-access-token:$GH_TOKEN@github.com/yourorg/tests.git" . && ./ci/test.sh' --wait
```

For SSH, pass the private key itself as `--env` (base64) and use it via `GIT_SSH_COMMAND` from a file in the job directory, which is deleted with the job (main README, §7.2).

## Docker

The Client doesn't pull images or start containers (and doesn't need Docker itself): the command does.

**Log in to a custom registry:** in `--command`, with credentials passed as `--env` under any names. Point `DOCKER_CONFIG` at the job's work directory first, so the login is deleted with the job rather than left in the Client user's `~/.docker` for later jobs:

```bash
export DOCKER_PASSWORD=…
thub run --type hw \
  --env DOCKER_REGISTRY=registry.lab.local:5000,DOCKER_USER=ci --env DOCKER_PASSWORD \
  --command 'export DOCKER_CONFIG="$THUB_WORK_DIR/.docker" &&
             echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USER" --password-stdin &&
             docker pull "$DOCKER_REGISTRY/team/test-runner:1.4"' \
  --wait
```

**Run the command inside a container:** `--command` starts on the Client host in the work directory (`$THUB_WORK_DIR`). Clone into it, then start the container mounting it:

```bash
thub run --type sw \
  --env DOCKER_REGISTRY=registry.lab.local:5000,DOCKER_USER=ci --env DOCKER_PASSWORD --env GH_TOKEN \
  --command 'git clone --depth 1 "https://x-access-token:$GH_TOKEN@github.com/yourorg/web-ui-tests.git" . &&
             export DOCKER_CONFIG="$THUB_WORK_DIR/.docker" &&
             echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USER" --password-stdin &&
             docker run --rm -v "$THUB_WORK_DIR:/work" -w /work "$DOCKER_REGISTRY/python:3.14" ./run-tests.sh' \
  --wait
```

**Clone the repository inside the image, with parameters from `--env`:**

```bash
thub run --type sw \
  --env DOCKER_REGISTRY=registry.lab.local:5000,DOCKER_USER=ci --env DOCKER_PASSWORD \
  --env TEST_IMAGE=registry.lab.local:5000/team/test-runner:1.4 \
  --env REPO_URL=git@bitbucket.org:yourorg/web-ui-tests.git,REPO_REF=main \
  --env 'GIT_SSH_COMMAND=ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new' \
  --command 'export DOCKER_CONFIG="$THUB_WORK_DIR/.docker" &&
             echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USER" --password-stdin &&
             docker run --rm -e REPO_URL -e REPO_REF -e GIT_SSH_COMMAND \
               -v "$HOME/.ssh:/root/.ssh:ro" -v "$THUB_WORK_DIR/results:/results" \
               "$TEST_IMAGE" sh -c "git clone --depth 1 --branch \"\$REPO_REF\" \"\$REPO_URL\" /src && cd /src && ./run-tests.sh --junit /results"' \
  --wait
```

The Client host needs Docker and the Client's user in the `docker` group for these (install Docker before the Client). Add `--dry-run` to see every command a job would run on the Client (every `--env` value shown as `***`) without running any. More in the main README, §7.2.

## Client environment variables

On the Client, the job's `--command` gets every option above as a `JOB_<NAME>` variable (the **On the Client** column). A variable whose option wasn't given is unset. A repeatable option gives `<NAME>` with all values plus `<NAME>_<n>` for each one. It also gets:
- its `--env` variables, under their own names;
- `THUB_JOB_ID`, `THUB_WORK_DIR` (where it runs), `THUB_DOWNLOADS_DIR`, `THUB_DOWNLOADS`, `THUB_DOWNLOAD_<n>` (local paths), `THUB_SUITE` and `THUB_META_<KEY>`;
- the DUT's `THUB_DUT_UART[_<n>]`, `THUB_DUT_USB[_<n>]`, `THUB_DUT_STLINK[_<n>]` (HW).

`THUB_*` and `JOB_*` names can't be set with `--env`. The full list is in the main README, §7.4.

```bash
thub run --type hw --label uart --suite smoke --command 'echo "suite $JOB_SUITE on $JOB_LABEL" && ./ci/test.sh' --wait
```

## Job status and PASS/FAIL

The verdict is `--command`'s exit code: `0` → **PASSED**, anything else → **FAILED**. ERROR, TIMEOUT, LOST and CANCELED mean the job didn't run to a verdict. JUnit XML written to `results/` or `artifacts/` in the work directory is summed into the job's `summary` by the Client. Nothing is uploaded: a job's files stay in its workspace on the Client, deleted when it ends — publish anything you need to keep from `--command`, e.g. to Artifactory.

**In CI:** `thub run … --wait` exits with the verdict code (table above): `0` PASSED, `1` FAILED, `2` infrastructure, `3` canceled.

**Check a job:**

```bash
thub status M-00125          # state; follows the log while active; then "Verdict: …" and test counts; exit = verdict
thub jobs --mine --state FAILED
```

**From a script:** `thub status <jobId> --json` prints the job once, with `state`, `exit_code`, `summary`, `message` and `resource.name`. It exits with the verdict code, or `5` while the job is still queued or running:

```bash
JOB=$(thub run --type sw --command ./ci/test.sh --detach --json | jq -r .jobId)
while thub status "$JOB" --json > job.json; [ $? -eq 5 ]; do sleep 10; done
jq -r '"\(.state) exit=\(.exit_code) failed=\(.summary.failed // 0)"' job.json   # PASSED exit=0 failed=0
```

## GitHub Actions

```yaml
test-sw:
  needs: build
  runs-on: ubuntu-latest
  env:
    THUB_URL: https://thub.example.com
    THUB_KEY: ${{ secrets.THUB_CI_TOKEN }}   # a CI token (dashboard → CI tokens)
  steps:
    - run: |
        npx -y @andrian.yablonskyy/thub-agent run --type sw \
          --download-file "${{ needs.build.outputs.image_url }}" \
          --env GH_TOKEN="${{ secrets.TESTS_READ_TOKEN }}",REPO="$GITHUB_REPOSITORY",SHA="$GITHUB_SHA" \
          --command 'git init -q . && git fetch -q --depth 1 "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" "$SHA" &&
                     git checkout -q FETCH_HEAD && ./ci/sw-tests.sh' --suite full --wait
```

If the GitHub job is canceled, the runner sends `SIGINT` to the Agent. In `--wait` mode (CI), that's treated as a cancel request (`POST /jobs/:id/cancel`) before exiting, so abandoned CI jobs don't hold hardware. In interactive mode, Ctrl-C only detaches.

## Development

```bash
npm install
npm run lint
```

## License

Proprietary — see the header comment in each source file.
