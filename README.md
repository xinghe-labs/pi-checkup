# pi-checkup

**`pi list` tells you what you installed. `pi-checkup` tells you what actually works.**

A health-check extension for [Pi](https://pi.dev). It inspects the *running* session — not just your `settings.json` — and reports the failures that produce no error message anywhere: tools silently shadowed by another package, binaries that resolve to a completely different program, packages that are installed but registered nothing, endpoints that stopped answering.

```text
/checkup
```

## The problem

A Pi install accumulates packages. Each one registers tools, commands, hooks, and sometimes shell binaries. When one of them stops working, nothing tells you:

- Two packages claimed the same tool name, and the second one silently won. The first is now unreachable.
- A package is in `settings.json`, its directory exists, but its manifest points at a file that isn't there. It loaded nothing and logged nothing.
- `ast-grep` ships a binary named `sg`. So does the shadow-utils package. Typing `sg` starts the wrong one.
- A blocked `postinstall` left `node_modules/.bin/playwright` as a dangling symlink.
- Your provider endpoint moved. The only symptom is a request that hangs 60 seconds later.

`pi list` prints paths. `pi --verbose` prints warnings you have to read line by line. Neither answers *"is my setup actually coherent right now?"*

## Install

```bash
pi install npm:pi-checkup
```

Then, in a session:

```text
/checkup            run every check
/checkup verbose    same, plus what to do about each finding
/checkup json       machine-readable report
/checkup fix        apply the safe repairs (asks first, backs up every file)
```

### When Pi will not start

The in-session command is useless in the one case you need it most: Pi is installed but will not boot. So the same checks also ship as a standalone CLI.

```bash
npx pi-checkup            # full report
npx pi-checkup --offline  # skip every network probe
npx pi-checkup --json     # for scripts
npx pi-checkup --fix -y   # apply the safe repairs without prompting
```

It exits `1` when any check fails, so it works as a pre-flight step in CI or a shell profile. After a repair it re-runs the checks and exits on the new result, so `pi-checkup --fix -y && start-pi` does what it looks like it does. `--json` cannot be combined with `--fix`: the JSON is a single snapshot, and a repair changes what the snapshot describes.

The registry section reports skipped — auditing loaded tools genuinely requires a live process — and the CLI says so instead of implying a clean bill of health.

```text
$ npx pi-checkup
Registry
  · live registry      no Pi session — registry checks need a running process
Packages
  ✓ package dirs       13 present
  ✓ manifests          13 readable
  ✓ entry files        12 manifest(s) resolve
Binaries
  ✓ dangling links     19 entries all resolve
  ✓ shadowed names     none
  ! unreachable bins   6 package command(s) not on PATH: pi-web-access-mcp,
                       pi-subagents, pi-mcp-adapter, pi-lens, pi-lens-mcp,
                       pi-lens-analyze
Network
  ✓ providers          2 endpoint(s) reachable
  ✓ dns                1 provider host(s) resolve normally
Config
  ✓ settings.json      valid JSON
  ✓ models.json        valid JSON
  · project settings   none
  ✓ backups            2 file(s) backed up; edited since the newest backup:
                       settings.json
  ✓ duplicate packages none
  · env references     no $VAR reference in models.json credentials
Runtime
  ✓ node               v22.23.3
  ✓ pi launcher        /root/.pi/agent/bin/pi
  ✓ disk               6% used, 950.9 GB free
  ✓ proxy              http://127.0.0.1:10808 accepting connections

19 checks: 15 ok, 1 warning, 0 failed, 3 skipped
Run `npx pi-checkup --verbose` to show what to do about each finding.

! 1 warning  ·  run /checkup inside Pi for registry checks
```

The footer line is the verdict, and it counts the skipped rows too: `✓ 3 ok, 2 skipped` rather than a bare "all clear" over a report where part of it was never checked.

## Real output

This is an actual run on a working install, copied out of the TUI at 80 columns. 21 of 24 checks pass, two are skipped because there is genuinely nothing to look at, and the one warning is a real problem that `pi list` said nothing about:

```text
Registry
  ✓ tools            49 registered (39 extension, 10 builtin) across 12 sources
  ✓ commands         94 registered across 20 sources, 0 MCP server(s)
  ✓ tool collisions  none
  ✓ command collisions none
  ✓ silent packages  none
Packages
  ✓ package dirs     13 present
  ✓ manifests        13 readable
  ✓ entry files      12 manifest(s) resolve
Binaries
  ✓ dangling links   19 entries all resolve
  ✓ shadowed names   none
  ! unreachable bins   6 package command(s) not on PATH: pi-web-access-mcp,
                       pi-subagents, pi-mcp-adapter, pi-lens, pi-lens-mcp,
                       pi-lens-analyze
Network
  ✓ providers        2 endpoint(s) reachable
  ✓ dns              1 provider host(s) resolve normally
Config
  ✓ settings.json    valid JSON (values read from the running session)
  ✓ models.json      valid JSON
  · project settings none
  ✓ backups          2 file(s) backed up; edited since the newest backup:
                     settings.json
  ✓ duplicate packages none
  · env references   no $VAR reference in models.json credentials
Runtime
  ✓ node             v22.23.3
  ✓ pi launcher      /root/.pi/agent/bin/pi
  ✓ disk             6% used, 950.9 GB free
  ✓ proxy            http://127.0.0.1:10808 accepting connections

24 checks: 21 ok, 1 warning, 0 failed, 2 skipped
Run `/checkup verbose` to show what to do about each finding.
```

## What it checks

| Group | Finding | Why it matters |
|---|---|---|
| **Registry** | Tool and command collisions | One extension silently stops being reachable; the later registration wins with no error |
| | Silent packages | Declared an extension but registered no tool or command — either by design or a load failure |
| | Attribution | Which package owns each of your tools and commands, by name |
| **Packages** | Missing directories | In `settings.json` but gone from `node_modules` |
| | Unreadable manifests | Corrupt or partially extracted `package.json` |
| | Missing entry files | The manifest points at a build output that was never shipped |
| **Binaries** | Dangling symlinks | Blocked `postinstall`, or an optional native dependency skipped for this platform |
| | Install leftovers | `.<name>-<random>` staging links in `.bin`: an install is running right now, or was interrupted. Its own finding, not a broken package |
| | Shadowed names | A package's command name resolves to an unrelated program earlier on `PATH` |
| | Unreachable bins | A package ships a CLI you cannot invoke by name |
| **Network** | Endpoint reachability | Probes `<baseUrl>/models` for every provider. `401`/`403` counts as alive — this never validates your key and never spends tokens |
| | Cleartext auth | A provider on `http://` with a key configured. The probe is sent without the key and the config is reported instead |
| | DNS | Provider hosts that do not resolve, or resolve only to loopback |
| **Config** | Invalid JSON | With a backup on disk, `/checkup fix` can restore it |
| | Duplicate package entries | The package loads twice and the second registration can shadow the first |
| | Unset env references | `$NAME` / `${NAME}` in the `models.json` fields Pi actually interpolates (`apiKey`, header values) with nothing in the environment |
| | Backups | Whether a broken config could be recovered at all |
| **Runtime** | Node version, launcher, disk, proxy | The host conditions Pi itself needs |

## `/checkup fix`

Only reversible repairs are automated:

1. **Restore a config file** that is no longer valid JSON, from its newest sibling backup. The broken copy is kept.
2. **Collapse duplicate `packages` entries** in `settings.json`.
3. **Prune `packages` entries whose directory is gone** — the ones a reinstall did not bring back. Sources resolved by Pi itself (`git:`, `https:`) are never touched.

Every write is preceded by a timestamped backup, and the command asks for confirmation before touching anything. Anything that would delete a package, disable an extension, or edit your shell environment is reported with a suggestion and left alone — a diagnostic tool should not be able to break your setup in the process of describing it.

Nothing is repaired unless a check found something wrong, so a healthy install writes nothing at all.

## Ignoring a finding you have decided to live with

Some warnings are correct and permanent: a launcher you deliberately keep off `PATH`, an event-only package that registers no tool. A health check you have learned to ignore is worse than no health check, so rows can be suppressed by name.

```bash
PI_CHECKUP_IGNORE=unreachable,Config:env npx pi-checkup
```

Each entry matches a row's `id`, its `Group:id` form, or its title. A suppressed row is downgraded to `skip`, keeps its original detail, and says what it replaced:

```text
  · unreachable bins   ignored via PI_CHECKUP_IGNORE (would be warn): 6 package
                       command(s) not on PATH: ...
```

Suppression is never silent, and it drops the row's repair offer so a hidden finding cannot be fixed behind your back. Export it from your shell profile if you want it to apply inside Pi too.

## JSON output

`/checkup json` prints the full report for scripts and CI:

```json
{
  "summary": { "total": 24, "ok": 21, "warn": 1, "fail": 0, "skip": 2 },
  "checks": [
    {
      "group": "Binaries",
      "id": "unreachable",
      "title": "unreachable bins",
      "status": "warn",
      "detail": "6 package command(s) not on PATH: pi-web-access-mcp, pi-subagents, pi-mcp-adapter, pi-lens, pi-lens-mcp, pi-lens-analyze",
      "hint": "Extensions that call these by full path still work; you and the agent cannot invoke them by name."
    },
    {
      "group": "Config",
      "id": "env",
      "title": "env references",
      "status": "skip",
      "detail": "no $VAR reference in models.json credentials"
    }
  ]
}
```

Exit-worthy statuses are `fail`; `warn` means something is degraded but working. Repair metadata is stripped from the JSON payload.

## Design principles

- **No traffic to anyone but your own provider.** The only outbound requests are `<baseUrl>/models` for providers already in `models.json`, plus a DNS lookup of those same hosts. The proxy check is a plain TCP connect to the proxy's own address — set `PI_CHECKUP_PROBE_URL` if you want a real end-to-end forwarding test.
- **No secrets printed, no keys validated.** A provider probe sends whatever auth header your config already defines and ignores the response body. A key on a plain-`http://` endpoint is never sent. A proxy URL is always shown as scheme, host and port — corporate proxies carry credentials in the URL, and `https_proxy` is the one place they usually live in plain text.
- **Non-blocking.** Every check runs concurrently, and every outbound call has its own timeout — 8s for a probe, 4s for DNS, 3s for a TCP connect — under a 30s per-module backstop. A hung endpoint costs 8 seconds, not the whole command.
- **A crashing check is a finding, not a crash.** If a check module throws, the report says which one, marks it failed, and still shows everything else.
- **A check with nothing to inspect says so.** `skip` always means "there was nothing to inspect", in every module — an absent optional config file, an empty `.bin`, a provider list with no host to resolve. Zero packages present reports `skip`, never a green tick over nothing, and the verdict counts them: `✓ 3 ok, 2 skipped` rather than a bare "all clear".
- **Cross-platform.** Node built-ins only. `PATH` is resolved in-process against `PATHEXT` on Windows and the executable bit on POSIX, so a minimal container without `which` still works; `curl` vs `NUL`, symlinked package stores, and path separators are handled. Checks that cannot run are marked skipped rather than failed.
- **Zero dependencies.** Nothing to audit, nothing to break on a Pi upgrade.

## Known limitations

Being explicit about what this cannot see:

- **Extension load errors are not exposed to extensions.** Pi's own `LoadExtensionsResult.errors` is not reachable from the extension API, so "which extension threw during load" is inferred statically (declared but unregistered), not read directly.
- **`git:` and URL package sources are not inspected.** Pi resolves them internally; static probing cannot follow them, so they are reported as `unverifiable` rather than guessed at.
- **The registry section needs a running session.** Tools and commands are read from the live process; the CLI reports that section as skipped rather than guessing from disk.
- **Tool collisions are reported, not resolved.** Pi's registry keeps the last registration; checkup tells you it happened.
- **The proxy check proves the port is open, not that forwarding works.** A TCP connect tells you the process is running; it says nothing about whether it can reach a given target. Set `PI_CHECKUP_PROBE_URL` for the full test, which uses `curl`.
- **Static checks describe the current session.** Install a package and the registry section is stale until `/reload`.
- **A run that overlaps an install describes a moving target.** Half-extracted packages and npm's staging links in `.bin` are visible for a second or two; checkup reports them as install leftovers and suggests re-running once the install finishes, but it cannot wait for it.

## Development

```bash
git clone https://github.com/xinghe-labs/pi-checkup
cd pi-checkup
npm run lint         # node --check over every source file
node --test          # 77 tests, no Pi session needed
```

To try a local checkout without installing:

```bash
pi -e ./src/index.js
```

Layout:

```text
bin/
  checkup.js         standalone CLI entry
src/
  index.js           in-session command registration, fix flow
  context.js         where a check gets its inputs (session vs disk)
  render.js          one formatter for text and JSON
  repair.js          the only module that writes to disk
  util.js            cross-platform helpers, no dependencies
  checks/
    index.js         the check registry, shared by command and CLI
    registry.js      what is loaded, who owns it, what collided
    packages.js      installed vs present vs loadable
    binaries.js      PATH reachability and shadowing
    network.js       provider endpoints and DNS
    config.js        JSON validity, backups, duplicates, env refs
    runtime.js       node, launcher, disk, proxy
```

Adding a check: export `group` and `run(ctx)`, return an array of `{ group, id, title, status, detail, hint? }`, and add the module to the `CHECKS` array in `src/checks/index.js`.

`ctx` carries everything a check may read — `agentDir`, `settingsFile`, `modelsFile`, `settings`, `settingsSource`, `hasRuntime`, `offline` — so no check reads a path on its own. Tests point `agentDir` at a temp directory; see `test/checks.test.js`.

## License

MIT
