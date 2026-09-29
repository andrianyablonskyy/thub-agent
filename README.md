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
thub status   <jobId>          Show status; follow log if running, show artifacts if done
thub cancel   <jobId>          Cancel a job
thub resources                 List resources and their status
thub jobs     [--mine] [--state <s>]   List recent jobs
thub config   set <key> <value>        Save coordinator URL / token / default group / default user locally
thub check-update                      Compare this Agent with the latest published version
thub self-update [--to <x.y.z>]        Update this Agent with npm i -g
thub --version
```

**Self-update.** An admin can request an update for this agent (or all agents) on the Coordinator's Agents page. The next command that talks to the Coordinator then installs it with `npm i -g` (retrying through `sudo` on an interactive terminal) and re-runs itself on the new version. If the install fails — e.g. no permission in CI — it prints the manual command and carries on with the current version; a run never fails because of an update. Set `THUB_NO_SELF_UPDATE=1` to opt out.

Key options for `thub run`:

| Option | Description |
|---|---|
| `--type hw\|sw` | Required resource type. |
| `--board <name>` / `--label <l>` | Required labels (repeatable). |
| `--group <groupId>` | Restrict scheduling to resources that are members of this group. Falls back to `THUB_GROUP` / `thub config set group <id>`. |
| `--client <name\|id>` | Run on this specific Client (resource name or id) only; the job waits in that Client's queue even if other matching resources are idle. |
| `--user <name>` | Free-text job owner — a label, not an identity. Falls back to `THUB_USER` / `thub config set user <name>`. |
| `--command <string>` | **Required.** The task's entry point: a shell command the Client runs (`sh -c`) in the task's work directory — the `--git-repo` checkout, else an empty directory — after preparing its inputs. Its exit code is the verdict. On HW it flashes the board itself (the Client doesn't); it gets `THUB_DUT_STLINK`/`_UART`/`_USB`/`_HOST`/`_CONTAINER`, `THUB_DOWNLOAD_<n>`, `THUB_DOWNLOADS_DIR`, `THUB_GIT_COMMIT`, `THUB_SUITE`, `THUB_META_*`. |
| `--download-file <url>` | A file the Client downloads before running the command (repeatable, `http(s)`), into the job's `downloads/` directory. |
| `--docker-image <name>` | SW only: a Docker image the Client runs as the DUT instead of its own `sw.image` (the Client must allow it: `sw.allowJobImages`). |
| `--git-repo <url> [<branch>\|<tag>\|<commit>]` | A git repository the Client clones (default ref: the default branch); the command runs in the checkout. |
| `--depth <n>` | With `--git-repo`: commits to fetch, default `1`; `0` = full history. |
| `--git-options <string>` | With `--git-repo`: extra git options placed between `git` and its subcommand on the Client, e.g. `'-c core.sshCommand="ssh -i ~/.ssh/lab_key -p 2222"'`. Shell-quoted (no shell run). Stored with the job, so reference key files rather than inlining secrets. |
| `--env <vars>` | Environment variables for every command the Client runs for the job (git, docker login, `--command`): `NAME=value[,NAME=value]`, repeatable; `--env NAME` alone takes the value from your shell. `DOCKER_REGISTRY` + `DOCKER_USERNAME` + `DOCKER_PASSWORD`: the Client logs in to that registry first (`docker login … --password-stdin`). Values reach only the Client running the job; the Coordinator masks them and drops them when the job ends. |
| `--suite <name>` | Passed to the command as `THUB_SUITE`. |
| `--arg <value>` | Extra argument for the command, as `"$@"` (repeatable). |
| `--timeout <dur>` | e.g. `30m`, default `30m`. |
| `--priority <n>` | 0–100; CI defaults to 50, CLI to 60 so a developer is not starved by a busy pipeline. |
| `--meta <key=value>` | Arbitrary metadata stored on the job (repeatable) — CI job ids, git coordinates, anything else worth attaching to the run. |
| `--dry-run` | Exercise the full pipeline without the Client executing anything for real. |
| `--wait` | Do not detach on job end; exit with the job's verdict code (used in CI). |
| `--detach` | Print the job id and exit immediately. |
| `--json` | Machine-readable output. |

- `thub run` prints the **job ID**, then streams logs until Ctrl-C. Ctrl-C detaches; the job keeps running on the Client.
- `thub status <jobId>` prints the current state; if active it keeps streaming, if done it prints the verdict and artifact download links.

Exit codes make the Agent usable as a CI step:

| Code | Meaning |
|---|---|
| `0` | `PASSED` |
| `1` | `FAILED` |
| `2` | `ERROR`, `TIMEOUT`, or `LOST` |
| `3` | `CANCELED` |
| `4` | Usage, auth or connection error |
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

**SW task in a Docker image of your own:**

```bash
thub run --type sw --docker-image alpine:3.20 \
  --git-repo git@github.com:yourorg/firmware-tests.git main --depth 20 \
  --command 'make test' --wait
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
