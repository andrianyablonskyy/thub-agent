# @andrian.yablonskyy/thub-agent

The Agent CLI (`thub`) is a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. `thub` is the single entry point for both: it's stateless, everything it knows comes from the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) API, and it runs identically on a GitHub-hosted runner and a developer laptop — a developer reproducing a CI failure runs exactly the same command the pipeline runs.

See how this fits with the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) and the [Client](https://github.com/andrianyablonskyy/thub-client).

## Install

```bash
npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-agent.git
# or, one-off in CI:
npx -y --package='git+https://github.com/andrianyablonskyy/thub-agent.git#semver:*' thub run --type sw --download-file "$IMAGE_URL" --command ./ci/test.sh --wait
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
thub power    on|off|reset <jobId> [--delay <sec>] [--port <n>]   Switch the USB power of the Client running your job (owner only)
thub report   <jobId> [--post gitlab|bitbucket|github] [--commit-status]   The job's report, or a sticky MR/PR comment
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
| `--suite <name>` | Test suite name for the command. | `JOB_SUITE` |
| `--arg <value>` | Extra argument for the command, as `"$@"` (repeatable). | `JOB_ARG`, `JOB_ARG_<n>` (and `"$@"`) |
| `--timeout <dur>` | e.g. `30m`, default `30m`. | `JOB_TIMEOUT` (seconds) |
| `--priority <n>` | 0–100; CI defaults to 50, CLI to 60 so a developer is not starved by a busy pipeline. | `JOB_PRIORITY` |
| `--meta <key=value>` | Arbitrary metadata stored on the job (repeatable) — CI job ids, git coordinates, anything else worth attaching to the run. | `JOB_META_<KEY>` (also `THUB_META_<KEY>`) |
| `--dry-run` | Exercise the full pipeline without the Client executing anything for real. | — (the command doesn't run) |
| `--id-file <path>` | Write the job id to this file as soon as it's queued, for a later `thub report`. | — (Agent only) |
| `--power-on-start on\|off\|reset` | HW only: switch the Client's USB power ports (uhubctl) before the DUT is prepared; a failure ends the job in `ERROR`. | `JOB_POWER_ON_START` |
| `--power-on-end on\|off\|reset` | HW only: switch them when the job ends, whatever its verdict. | `JOB_POWER_ON_END` |
| `--power-reset-delay <sec>` | How long a `reset` keeps the power off, 0–60 s; default `1`. | `JOB_POWER_RESET_DELAY` |
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

### USB port power (HW)

On a Client with USB power ports (uhubctl, see the main README §8.7), a job can cold-boot its board and switch it off at the end. Its owner can also power-cycle it while it runs, without canceling the job:

```bash
thub run --type hw --label board:nucleo-f401re \
  --download-file "$IMAGE_URL" --command './ci/flash-and-test.sh' \
  --power-on-start reset --power-reset-delay 2 --power-on-end off --wait

thub power reset M-00131                      # every port, 1 s off (the default delay)
thub power reset M-00131 --port 2 --delay 3   # the Client's second port, 3 s off
thub power off M-00131
```

`thub power` works only for your own job, while it's `PREPARING` or `RUNNING`; otherwise the Coordinator says why it refused. The job's log shows each action:

```
[runner] USB power reset (port 2) requested by alice (thub power)
[runner] USB power reset: 1-1.4:3 (off 3 s)
```

### Smart sockets, PDUs and other lab devices

Boards on a smart socket (Shelly, Tasmota, Kasa, Home Assistant) or a PDU outlet are switched by the job itself. Its `--command`, or a script from the repository it clones, calls the device with `curl`, `snmpset` or the device's own CLI, with credentials passed as `--env`. Each Client instance names its bench's device in its environment (e.g. `BENCH_POWER=shelly:10.0.20.11`, set with a systemd drop-in):

```bash
# inline: Shelly Gen2 off, 2 s, on, then the tests
thub run --type hw --label board:nucleo-f401re --env SHELLY_PASSWORD \
  --command 'S="http://$BENCH_IP/rpc/Switch.Set?id=0"
             curl -fsS --digest -u "admin:$SHELLY_PASSWORD" "$S&on=false" && sleep 2 &&
             curl -fsS --digest -u "admin:$SHELLY_PASSWORD" "$S&on=true" && ./ci/test.sh' --wait

# from the test repository: ci/run.sh resets the bench's socket or PDU outlet, tests, and always powers it off
thub run --type hw --env GH_TOKEN --env POWER_PASSWORD \
  --command 'git clone --depth 1 "https://x-access-token:$GH_TOKEN@github.com/yourorg/firmware-tests.git" src && cd src && exec ci/run.sh' --wait
```

Use `exec` so a canceled job's `SIGTERM` reaches the script's trap. The full `ci/power.sh` and `ci/run.sh` examples (Shelly, Tasmota, Home Assistant, Kasa, APC PDU over SNMP) are in the main README, §8.8, and in the dashboard's Help.

## Examples

**Run a task** — download the firmware, clone the tests at a tag, flash and test (HW):

```bash
export GH_TOKEN=…   # read access to the tests repository
thub run --type hw --label board:nucleo-f401re \
  --download-file "$IMAGE_URL" --env GH_TOKEN \
  --command 'git clone --depth 1 --branch v1.4.0 "https://x-access-token:$GH_TOKEN@github.com/yourorg/firmware-tests.git" src && cd src &&
             st-flash --reset write "$THUB_DOWNLOAD_1" 0x08000000 && ./ci/test.sh "$@"' \
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
  --command 'git clone --depth 1 --branch "$REF" "https://x-access-token:$GH_TOKEN@github.com/yourorg/tests.git" src && cd src && ./ci/test.sh' --wait
```

For SSH, pass the private key itself as `--env` (base64) and use it via `GIT_SSH_COMMAND` from a file in the job directory, which is deleted with the job (main README, §7.2).

## Docker

The Client doesn't pull images or start containers (and doesn't need Docker itself): the command does.

**Log in to a custom registry:** in `--command`, with credentials passed as `--env` under any names. Point `DOCKER_CONFIG` at the job's work directory first, so the login is deleted with the job rather than left in the Client user's `~/.docker` for later jobs:

```bash
export DOCKER_PASSWORD=…
thub run --type hw \
  --env DOCKER_REGISTRY=registry.lab.local:5000,DOCKER_USER=ci --env DOCKER_PASSWORD \
  --command 'echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USER" --password-stdin &&
             docker pull "$DOCKER_REGISTRY/team/test-runner:1.4"' \
  --wait
```

**Run the command inside a container:** `--command` starts on the Client host in the job's directory (`$THUB_WORK_DIR`). Clone into `src/`, then start the container mounting only `src/` (the directory also holds `.docker/`, the job's registry login):

```bash
thub run --type sw \
  --env DOCKER_REGISTRY=registry.lab.local:5000,DOCKER_USER=ci --env DOCKER_PASSWORD --env GH_TOKEN \
  --command 'git clone --depth 1 "https://x-access-token:$GH_TOKEN@github.com/yourorg/web-ui-tests.git" src && cd src &&
             echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USER" --password-stdin &&
             docker run --rm --user "$(id -u):$(id -g)" -v "$THUB_WORK_DIR/src:/work" -w /work "$DOCKER_REGISTRY/python:3.14" ./run-tests.sh' \
  --wait
```

**Clone and test inside a container, with a deploy key and a registry login from `--env`** (the reference example for passing data and secrets to a job):

```bash
# In CI, from its secret store — never typed on the command line:
export THUB_KEY=…                              # a CI token (dashboard → CI tokens)
export DOCKER_PASSWORD=…                       # the registry password
export GIT_KEY="$(cat ~/.ssh/thub_deploy)"     # a private deploy key with read access to the repository

thub run --type sw \
  --env DOCKER_REGISTRY=registry.lab:5000,DOCKER_USERNAME=ci-reader \
  --env DOCKER_PASSWORD --env GIT_KEY \
  --command 'echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USERNAME" --password-stdin &&
             mkdir -p "$THUB_WORK_DIR/src" &&
             docker run --rm -e GIT_KEY -e HOME=/tmp --user "$(id -u):$(id -g)" \
               -v "$THUB_WORK_DIR/src:/work" -w /work --entrypoint sh alpine/git -c "
               eval \$(ssh-agent -s) > /dev/null &&
               printf \"%s\n\" \"\$GIT_KEY\" | ssh-add - &&
               GIT_SSH_COMMAND=\"ssh -o StrictHostKeyChecking=accept-new\" git clone --depth 1 git@bitbucket.org:yourorg/web-ui-tests.git . &&
               ./run-tests.sh"' \
  --wait
```

Plain values go as `--env NAME=value`, secrets as `--env NAME` (taken from your environment, so never on the command line; multi-line values arrive intact). The inner script's `\$` is expanded in the container; `ssh-agent` keeps the key in memory only; `--entrypoint sh` because `alpine/git`'s entrypoint is `git`; `--user` keeps the clone deletable by the Client. Only `src/` is mounted, so the registry login (the Client's `DOCKER_CONFIG`, `$THUB_WORK_DIR/.docker`) stays out of the container. More in the main README, §7.2.

The Client host needs Docker and the Client's user in the `docker` group for these (install Docker before the Client). Add `--dry-run` to see every command a job would run on the Client (every `--env` value shown as `***`) without running any. More in the main README, §7.2.

## Client environment variables

On the Client, the job's `--command` gets every option above as a `JOB_<NAME>` variable (the **On the Client** column). A variable whose option wasn't given is unset. A repeatable option gives `<NAME>` with all values plus `<NAME>_<n>` for each one. It also gets:
- its `--env` variables, under their own names;
- `THUB_JOB_ID`, `THUB_WORK_DIR` (where it runs), `THUB_DOWNLOADS_DIR`, `THUB_DOWNLOADS`, `THUB_DOWNLOAD_<n>` (local paths) and `THUB_META_<KEY>`. HW devices are used by their `/dev/thub/dut<N>-uart|usb|stlink` paths; no device variables are passed.

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

## CI/CD: GitHub Actions, GitLab, Bitbucket, Jenkins

Every CI system works the same way: store a CI token (dashboard → CI tokens) as the secret `THUB_KEY`, set `THUB_URL`, and run `thub run … --wait` on a runner with Node.js 24. The step's exit code is the verdict. Set `THUB_NO_SELF_UPDATE=1` on short-lived runners.

### GitHub Actions

The TestHub action does it in one step: the job's log in the step, a Job Summary with every test, a pull-request comment (verdict, board, time, log link; updated in place on re-runs) and an optional commit status:

```yaml
- uses: andrianyablonskyy/thub-action@v1
  with:
    url: https://thub.example.com
    key: ${{ secrets.THUB_CI_TOKEN }}
    type: hw
    labels: board:nucleo-f401re
    download-files: ${{ needs.build.outputs.image_url }}
    command: st-flash --reset write "$THUB_DOWNLOAD_1" 0x08000000 && ./ci/hw-tests.sh
```

The PR comment it leaves:

```
### ❌ TestHub HW smoke: FAILED
| Job      | A-00042                                   |
| Result   | FAILED (exit code 1)                      |
| Board    | nucleo-f401re on lab-hw-01                |
| Tests    | 42 total · 40 passed · 2 failed · 0 skipped |
| Duration | 3m 12s (queued 20s)                       |
| Commit   | abcdef1                                   |
| Links    | Job page and full log · Workflow run      |
▸ Failed tests (2)
```

Use its outputs in later steps:

```yaml
      - id: thub
        uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          type: hw
          labels: board:nucleo-f401re
          command: ./ci/hw-tests.sh
      - if: always() && steps.thub.outputs.job-id
        run: |
          echo "TestHub ${{ steps.thub.outputs.job-id }} on ${{ steps.thub.outputs.client }}: ${{ steps.thub.outputs.state }}"
          echo "${{ steps.thub.outputs.passed }}/${{ steps.thub.outputs.total }} tests passed in ${{ steps.thub.outputs.duration-sec }} s"
          echo "Log: ${{ steps.thub.outputs.job-url }}"
```

Report only, quietly, with the verdict as a commit status:

```yaml
      - uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          type: sw
          command: ./ci/sw-tests.sh
          fail: false
          comment: on-failure
          commit-status: true
```

Complete workflows, every input, and how the PR comment and test table work are in the [thub-action README](https://github.com/andrianyablonskyy/thub-action#readme) and the main README §11.1.

With the Agent directly:

```yaml
test-sw:
  needs: build
  runs-on: ubuntu-latest
  env:
    THUB_URL: https://thub.example.com
    THUB_KEY: ${{ secrets.THUB_CI_TOKEN }}   # a CI token (dashboard → CI tokens)
  steps:
    - run: |
        npx -y --package='git+https://github.com/andrianyablonskyy/thub-agent.git#semver:*' thub run --type sw \
          --download-file "${{ needs.build.outputs.image_url }}" \
          --env GH_TOKEN="${{ secrets.TESTS_READ_TOKEN }}",REPO="$GITHUB_REPOSITORY",SHA="$GITHUB_SHA" \
          --command 'git init -q src && cd src && git fetch -q --depth 1 "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" "$SHA" &&
                     git checkout -q FETCH_HEAD && ./ci/sw-tests.sh' --suite full --wait
```

In `--wait` mode, `SIGINT` and `SIGTERM` (how GitHub, GitLab and Jenkins stop a canceled step) make the Agent cancel the job (`POST /jobs/:id/cancel`) before exiting, so abandoned CI jobs don't hold hardware. In interactive mode, Ctrl-C only detaches.

### GitLab CI/CD

```yaml
test-hw:
  image: node:24
  variables: { THUB_URL: https://thub.example.com, THUB_NO_SELF_UPDATE: "1" }   # THUB_KEY: a masked CI/CD variable
  script:
    - |
      npx -y --package='git+https://github.com/andrianyablonskyy/thub-agent.git#semver:*' thub run --type hw --label board:nucleo-f401re --download-file "$IMAGE_URL" \
        --env CI_JOB_TOKEN --env CI_SERVER_HOST --env CI_PROJECT_PATH --env CI_COMMIT_SHA \
        --command 'git init -q src && cd src &&
                   git fetch -q --depth 1 "https://gitlab-ci-token:$CI_JOB_TOKEN@$CI_SERVER_HOST/$CI_PROJECT_PATH.git" "$CI_COMMIT_SHA" &&
                   git checkout -q FETCH_HEAD && ./ci/hw-tests.sh' \
        --wait --meta pipelineUrl="$CI_PIPELINE_URL"
```

### Bitbucket Pipelines

```yaml
- step:
    name: HW tests
    image: node:24
    script:   # repository variables: THUB_URL, THUB_KEY (secured), TESTS_TOKEN (a repository access token)
      - >-
        npx -y --package='git+https://github.com/andrianyablonskyy/thub-agent.git#semver:*' thub run --type hw --download-file "$IMAGE_URL"
        --env TESTS_TOKEN --env BITBUCKET_REPO_FULL_NAME --env BITBUCKET_COMMIT
        --command 'git init -q src && cd src &&
        git fetch -q --depth 1 "https://x-token-auth:$TESTS_TOKEN@bitbucket.org/$BITBUCKET_REPO_FULL_NAME.git" "$BITBUCKET_COMMIT" &&
        git checkout -q FETCH_HEAD && ./ci/hw-tests.sh' --wait
```

### Jenkins

```groovy
stage('HW tests') {
  agent { docker { image 'node:24' } }
  environment {
    THUB_URL = 'https://thub.example.com'
    THUB_KEY = credentials('thub-ci-token')          // Secret text
    NPM_CONFIG_CACHE = "${env.WORKSPACE}/.npm"
  }
  steps {
    sh '''
      npx -y --package='git+https://github.com/andrianyablonskyy/thub-agent.git#semver:*' thub run --type hw --download-file "$IMAGE_URL" \
        --command './ci/hw-tests.sh' --wait --meta buildUrl="$BUILD_URL"
    '''
  }
}
```

Full pipelines — build, test, and bringing the JUnit report back into GitLab, Bitbucket or Jenkins — are in the main README, §11, and in the dashboard's Help.

### Merge/pull-request comments: GitLab, Bitbucket, Jenkins

`thub report <jobId>` renders the same report the GitHub Action leaves: verdict, board, Client, duration, tests, failed tests, and links to the job's log and the pipeline. `--post gitlab|bitbucket|github` keeps it as one comment on the merge/pull request, updated by every later run, and `--commit-status` sets the commit's status, linking to the job. Save the id with `thub run --id-file`, and report in the step that runs whatever the result.

GitLab, with a project access token (`api` scope, Reporter) in the masked variable `GITLAB_TOKEN`:

```yaml
# .gitlab-ci.yml
test-hw:
  stage: test
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"     # CI_MERGE_REQUEST_IID: the MR to comment on
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH            # status only (a branch pipeline's open MR, if any, is found by commit)
  variables:
    THUB_URL: https://thub.example.com                       # THUB_KEY, GITLAB_TOKEN: masked CI/CD variables
    THUB_NO_SELF_UPDATE: "1"
  before_script:
    - npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-agent.git
  script:
    - thub run --type hw --label board:nucleo-f401re --download-file "$IMAGE_URL"
        --command './ci/hw-tests.sh' --suite smoke --timeout 30m --wait --id-file .thub-job
        --meta pipelineUrl="$CI_PIPELINE_URL"
  after_script:                                              # runs after failures and cancels too
    - '[ -s .thub-job ] && thub report "$(cat .thub-job)" --post gitlab --commit-status --title "HW smoke"'
```

Bitbucket Cloud, with a repository access token (Pull requests: Write) in the secured variable `BITBUCKET_TOKEN`:

```yaml
# bitbucket-pipelines.yml
image: node:24
pipelines:
  pull-requests:
    '**':
      - step:
          name: HW tests
          max-time: 60
          script:                                            # THUB_URL, THUB_KEY, BITBUCKET_TOKEN: repository variables
            - export THUB_NO_SELF_UPDATE=1
            - npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-agent.git
            - thub run --type hw --label board:nucleo-f401re --command './ci/hw-tests.sh' --suite smoke --timeout 30m --wait --id-file .thub-job
          after-script:                                      # runs whether the step passed or failed
            - '[ -s .thub-job ] && thub report "$(cat .thub-job)" --post bitbucket --commit-status --title "HW smoke"'
```

Jenkins, Bitbucket Data Center, every `thub report` option, and which CI variables each code host reads: main README, §11.5.

## Test frameworks and the PR comment

The verdict is the command's exit code. Test counts come from JUnit XML the command writes to `results/` (or `artifacts/`, either one folder down too):

```bash
--command '… ./build/uart_tests --gtest_output=xml:results/ …'                          # GoogleTest
--command '… ctest --test-dir build --output-junit "$PWD/results/ctest.xml" …'          # CTest (absolute path)
--command '… pytest tests/ --junitxml=results/pytest.xml -o junit_family=xunit2 …'      # pytest
--command '… mvn -B test; rc=$?; mkdir -p results && cp target/surefire-reports/TEST-*.xml results/; exit $rc'   # JUnit / Maven
```

To have **every test case** in the PR/MR comment, have the command publish the XML and list it as an artifact (`ci/publish-junit.sh`). The GitHub Action or `thub report --artifact-header …` then fetches it. Full examples, including hardware-in-the-loop with pytest: main README §7.6.

## Artifact storage

`--download-file` is a plain, anonymous GET. For private storage, either pass a short-lived signed URL (`aws s3 presign …`), or fetch the file in `--command` with credentials passed as `--env`. Outputs are uploaded by the command and listed in `$THUB_ARTIFACTS_FILE`:

```bash
thub run --type sw --env ART_TOKEN \
  --command './ci/test.sh; rc=$?
             curl -fsS -H "Authorization: Bearer $ART_TOKEN" -T results/junit.xml "https://artifactory.example.com/qa/$THUB_JOB_ID/junit.xml"
             exit $rc' --wait
```

The main README, §7.5, and the dashboard's Help have examples for Artifactory, AWS S3, Google Drive (rclone), FTP/FTPS/SFTP, and custom HTTP authentication (bearer, API key, basic, `.netrc`, mutual TLS, OAuth2).

More authentication how-tos, in the main README and the dashboard's Help:

- **Downloads over HTTPS:** a private CA (`NODE_EXTRA_CA_CERTS` on the Client), and client certificates (`curl --cert` in `--command`; `--download-file` can't present one). See §7.5.
- **Artifactory:** scoped, short-lived access tokens minted per CI run, the JFrog CLI, and signed URLs. See §7.5.
- **git over SSH:** a deploy key plus a pinned `known_hosts`, both passed with `--env`. See §7.2.
- **`docker login`:** your own registry, Artifactory, ghcr, GitLab, Docker Hub, ECR, Google Artifact Registry and ACR. See §7.2.

## Development

```bash
npm install
npm run lint
```

## License

See [LICENSE.md](./LICENSE.md).
