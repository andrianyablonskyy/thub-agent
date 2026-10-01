# @andrian.yablonskyy/thub-agent

The Agent CLI (`thub`) for [TestHub](https://github.com/andrianyablonskyy/thub) — a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. `thub` is the single entry point for both: it's stateless, everything it knows comes from the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) API, and it runs identically on a GitHub-hosted runner and a developer laptop — a developer reproducing a CI failure runs exactly the same command the pipeline runs.

See the [main TestHub repo](https://github.com/andrianyablonskyy/thub) for the full system architecture and how this fits with the Coordinator and the [Client](https://github.com/andrianyablonskyy/thub-client).

## Install

```bash
npm i -g @andrian.yablonskyy/thub-agent
# or, one-off in CI:
npx -y @andrian.yablonskyy/thub-agent run --type sw --download-file "$IMAGE_URL" --git-repo "$TESTS_REPO" --command ./ci/test.sh --wait
```

## Configuration

Read from flags, then environment (`THUB_URL`, `THUB_TOKEN`, `THUB_GROUP`, `THUB_USER`), then `~/.config/thub/agent.json`, then a bundled default. `url`/`token` are required by the time a command actually talks to the Coordinator; `group`/`user` are optional everywhere.

`npm install -g` creates `~/.config/thub/agent.json` for you (blank `url`/`token`, so nothing works until you set them) if it doesn't already exist — a re-install never overwrites it. Fill it in with `thub config set`:

```bash
thub config set url https://thub.example.com
thub config set token agt_...
thub config set group 548ae4ae-...   # optional default --group
thub config set user "Your Name"     # optional default --user
```

## Commands

```
thub run      [options]        Submit a test job and follow its log
thub status   <jobId>          Show status; follow log if running, verdict, test counts and artifacts if done
thub cancel   <jobId>          Cancel a job
thub resources                 List resources and their status
thub jobs     [--mine] [--state <s>]   List recent jobs (a cli token: only its own; a ci token: all, or its own with --mine)
thub config   set <key> <value>        Save coordinator URL / token / default group / default user locally
thub check-update                      Compare this Agent with the latest published version
thub self-update [--to <x.y.z>]        Update this Agent with npm i -g
thub --version
```

**Self-update.** An admin can request an update for this agent (or all agents) on the Coordinator's Agents page. The next command that talks to the Coordinator then installs it with `npm i -g` (retrying through `sudo` on an interactive terminal) and re-runs itself on the new version. If the install fails — e.g. no permission in CI — it prints the manual command and carries on with the current version; a run never fails because of an update. Set `THUB_NO_SELF_UPDATE=1` to opt out.

Key options for `thub run`. **On the Client** names the environment variable the job's command finds the option's value in (see *Client environment variables* below):

| Option | Description | On the Client |
|---|---|---|
| `--type hw\|sw` | Required resource type. | `JOB_TYPE` |
| `--board <name>` / `--label <l>` | Required labels (repeatable). | `JOB_BOARD`; `JOB_LABEL`, `JOB_LABEL_<n>` |
| `--group <groupId>` | Restrict scheduling to resources that are members of this group. Falls back to `THUB_GROUP` / `thub config set group <id>`. | `JOB_GROUP` |
| `--client <name\|id>` | Run on this specific Client (resource name or id) only; the job waits in that Client's queue even if other matching resources are idle. | `JOB_CLIENT` |
| `--user <name>` | Free-text job owner — a label, not an identity. Falls back to `THUB_USER` / `thub config set user <name>`. | `JOB_USER` |
| `--command <string>` | **Required.** The task's entry point: a shell command the Client runs (`sh -c`) in the task's work directory — the `--git-repo` checkout, else an empty directory — after preparing its inputs. Its exit code is the verdict. On HW it flashes the board itself (the Client doesn't); it gets `THUB_DUT_STLINK`/`_UART`/`_USB`/`_HOST`/`_CONTAINER`, `THUB_DOWNLOAD_<n>`, `THUB_DOWNLOADS_DIR`, `THUB_GIT_COMMIT`, `THUB_SUITE`, `THUB_META_*`. | `JOB_COMMAND` |
| `--download-file <url>` | A file the Client downloads before running the command (repeatable, `http(s)`), into the job's `downloads/` directory. | `JOB_DOWNLOAD_FILE`, `JOB_DOWNLOAD_FILE_<n>` (URLs); `THUB_DOWNLOAD_<n>` (local paths) |
| `--docker-image <name>` | SW only: a Docker image the Client runs as the **DUT** (an emulator the tests talk to, at `$THUB_DUT_HOST` / `$THUB_DUT_CONTAINER`) — any SW Client runs it; without one, an SW job has no DUT container. It's not where `--command` runs: to run the tests in an image, see [Docker](#docker). | `JOB_DOCKER_IMAGE` |
| `--git-repo <url> [<branch>\|<tag>\|<commit>]` | A git repository the Client clones (default ref: the default branch); the command runs in the checkout. | `JOB_GIT_REPO_URL`, `JOB_GIT_BRANCH` |
| `--depth <n>` | With `--git-repo`: commits to fetch, default `1`; `0` = full history. | `JOB_GIT_DEPTH` |
| `--git-options <string>` | With `--git-repo`: extra git options placed between `git` and its subcommand on the Client, e.g. `'-c core.sshCommand="ssh -i ~/.ssh/lab_key -p 2222"'`. Shell-quoted (no shell run). Stored with the job, so reference key files rather than inlining secrets. | `JOB_GIT_OPTIONS` |
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

**Run a task** — download the firmware, check out the tests at a tag, flash and test (HW):

```bash
thub run --type hw --board nucleo-f401re \
  --download-file "$IMAGE_URL" \
  --git-repo https://github.com/yourorg/firmware-tests.git v1.4.0 \
  --command 'st-flash --serial "$THUB_DUT_STLINK" --reset write "$THUB_DOWNLOAD_1" 0x08000000 && ./ci/test.sh "$@"' \
  --arg --junit --wait
```

**SW task against a DUT emulator image of your own** (the command runs on the Client host and talks to the emulator):

```bash
thub run --type sw --docker-image registry.lab.local:5000/dut-emulator:2026.08 \
  --git-repo git@github.com:yourorg/firmware-tests.git main --depth 20 \
  --command 'make test DUT="$THUB_DUT_HOST"' --wait
```

**Associate a CI/CD job id with the internal job id:**

```bash
thub run --type sw --download-file "$IMAGE_URL" --git-repo "$TESTS_REPO" --command ./ci/test.sh \
  --meta ciJobId="$GITHUB_RUN_ID" --wait
thub status A-00123 --json | jq '.spec.meta.ciJobId'
```

**Pass extra metadata** — `--meta key=value` reaches the command as `THUB_META_<KEY>` (`ciJobId` → `THUB_META_CI_JOB_ID`).

**Dry-run the pipeline** — proves the Coordinator↔Client plumbing works without real hardware, a real emulator image, or reachable downloads:

```bash
thub run --type sw --download-file https://does-not-exist.invalid/app.bin \
  --command ./ci/test.sh --dry-run --wait
```

**Run on a specific resource group only:**

```bash
thub run --type sw --git-repo "$TESTS_REPO" --command ./ci/test.sh \
  --group 548ae4ae-ac5b-401f-acaa-24bbe790e62d --wait
```

**Label a job with its owner** — purely informational, shows up on the dashboard, in `thub jobs`, and on the Client's own console:

```bash
thub run --type hw --board nucleo-f401re \
  --git-repo "$TESTS_REPO" --command ./ci/test.sh --user "Your Name" --wait
```

## Environment variables and secrets

`--env NAME=value[,NAME=value]` (repeatable) sets variables for every command the Client runs for the job: git and `--command`. The names are yours; none means anything to the Agent or the Client. `--env NAME` alone takes the value from your own environment, so a secret stays off the command line and out of CI logs:

```bash
export API_TOKEN=…
thub run --type sw --git-repo "$TESTS_REPO" \
  --env TARGET=staging --env API_TOKEN \
  --command './run-tests.sh --target "$TARGET"' --wait
```

**How the values are kept secret:**

- They reach **only the Client that runs the job**.
- The Agent API shows every value as `***`: `thub status --json`, `thub jobs --json`, even for your own job. The dashboard lists the names only.
- The Coordinator replaces the values with `***` once the job ends.
- A `--dry-run` shows every value as `***`, whatever its name.

Your command's output is the job's log, so don't print secrets. Everything else — `--command`, `--arg`, `--meta`, `--git-options` — is stored as is and visible, so never put secrets there.

## Docker

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

**Pull an image as the DUT:** `--docker-image` is pulled by the Client before the command runs, as its service user. For a private registry, log in once on the Client host as that user: `sudo -u thub docker login registry.lab.local:5000`.

```bash
thub run --type sw --docker-image registry.lab.local:5000/dut-emulator:2026.08 \
  --git-repo "$TESTS_REPO" --command './ci/test.sh --dut "$THUB_DUT_HOST"' --wait
```

**Run the command inside a container:** `--command` starts on the Client host in the work directory (`$THUB_WORK_DIR`, the `--git-repo` checkout). Start the container from it, mounting that directory:

```bash
thub run --type sw \
  --env DOCKER_REGISTRY=registry.lab.local:5000,DOCKER_USER=ci --env DOCKER_PASSWORD \
  --git-repo git@bitbucket.org:yourorg/web-ui-tests.git main \
  --git-options '-c core.sshCommand="ssh -i /home/thub/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new"' \
  --command 'export DOCKER_CONFIG="$THUB_WORK_DIR/.docker" &&
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

The Client host needs Docker and the Client's user in the `docker` group; SW Clients have both. Add `--dry-run` to see every command a job would run on the Client (every `--env` value shown as `***`) without running any. More in the main README, §7.2.

## Client environment variables

On the Client, the job's `--command` gets every option above as a `JOB_<NAME>` variable (the **On the Client** column). A variable whose option wasn't given is unset. A repeatable option gives `<NAME>` with all values plus `<NAME>_<n>` for each one. It also gets:
- its `--env` variables, under their own names;
- `THUB_JOB_ID`, `THUB_WORK_DIR` (where it runs), `THUB_GIT_COMMIT`, `THUB_DOWNLOADS_DIR`, `THUB_DOWNLOADS`, `THUB_DOWNLOAD_<n>` (local paths), `THUB_SUITE` and `THUB_META_<KEY>`;
- the DUT's `THUB_DUT_UART[_<n>]`, `THUB_DUT_USB[_<n>]`, `THUB_DUT_STLINK[_<n>]` (HW), or `THUB_DUT_HOST` and `THUB_DUT_CONTAINER` (SW with `--docker-image`).

`THUB_*` and `JOB_*` names can't be set with `--env`. The full list is in the main README, §7.4.

```bash
thub run --type sw --git-repo git@bitbucket.org:yourorg/tests.git main --depth 1 \
  --command 'git clone --depth "$JOB_GIT_DEPTH" ${JOB_GIT_BRANCH:+--branch "$JOB_GIT_BRANCH"} "$JOB_GIT_REPO_URL" src && cd src && ./run-tests.sh' \
  --wait
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
JOB=$(thub run --type sw --git-repo "$TESTS_REPO" --command ./ci/test.sh --detach --json | jq -r .jobId)
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
    THUB_TOKEN: ${{ secrets.THUB_AGENT_TOKEN }}
  steps:
    - run: |
        npx -y @andrian.yablonskyy/thub-agent run --type sw \
          --download-file "${{ needs.build.outputs.image_url }}" \
          --git-repo "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" "$GITHUB_SHA" \
          --command ./ci/sw-tests.sh --suite full --wait
```

If the GitHub job is canceled, the runner sends `SIGINT` to the Agent. In `--wait` mode (CI), that's treated as a cancel request (`POST /jobs/:id/cancel`) before exiting, so abandoned CI jobs don't hold hardware. In interactive mode, Ctrl-C only detaches.

## Development

```bash
npm install
npm run lint
```

## License

Proprietary — see the header comment in each source file.
