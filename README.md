# pi-checkup

**`pi list` tells you what you installed. `pi-checkup` tells you what actually works.**

A health-check extension for [Pi](https://pi.dev). It inspects the *running* session — not just your `settings.json` — and reports the failures that produce no error message anywhere: tools silently shadowed by another package, binaries that resolve to a completely different program, packages that are installed but registered nothing, endpoints that stopped answering.

## Install

```bash
pi install npm:pi-checkup
```

Then, in a session:

```text
/checkup            run every check
/checkup verbose    same, plus what to do about each finding
/checkup json       machine-readable report
/checkup fix        apply the safe repairs (asks first)
```

## The problem

A Pi install accumulates packages. Each one registers tools, commands, hooks, and sometimes shell binaries. When one of them stops working, nothing tells you:

- Two packages claimed the same tool name, and the second one silently won. The first is now unreachable.
- A package is in `settings.json`, its directory exists, but its manifest points at a file that isn't there. It loaded nothing and logged nothing.
- `ast-grep` ships a binary named `sg`. So does the shadow-utils package. Typing `sg` starts the wrong one.
- A blocked `postinstall` left `node_modules/.bin/playwright` as a dangling symlink.
- Your provider endpoint moved. The only symptom is a request that hangs 60 seconds later.

`pi list` prints paths. `pi --verbose` prints warnings you have to read line by line. Neither answers *"is my setup actually coherent right now?"*

## The standalone CLI

The in-session command is useless in the one case you need it most: Pi is installed but will not boot. The same checks also ship as a CLI that needs no session, no Pi, and no `node_modules` — which is also what you want in CI, or on a machine you are about to hand over.

```bash
npx pi-checkup              # full report
npx pi-checkup --verbose    # same report, plus the hint under every finding
npx pi-checkup --offline    # skip every network probe
npx pi-checkup --json       # for scripts
npx pi-checkup --fix        # list the safe repairs
npx pi-checkup --fix -y     # apply them without prompting
npx pi-checkup --version    # print the version
npx pi-checkup --help       # every flag and exit code
```

Requires Node 20 or newer (`engines` in `package.json`); no dependencies, no `node_modules`.

It exits `1` when any check fails, so it works as a pre-flight step in CI or a shell profile. After a repair it re-runs the checks and exits on the new result, so `npx pi-checkup --fix -y && start-pi` does what it looks like it does. `--json` cannot be combined with `--fix`: the JSON is a single snapshot, and a repair changes what the snapshot describes.

The registry section reports skipped — auditing loaded tools genuinely requires a live process — and the CLI says so instead of implying a clean bill of health.

Exit codes: `0` nothing failed, `1` at least one check failed, `2` bad usage or a crashed run. The `--json` payload is the same report the text renderer prints, minus the repair metadata.

| Variable | Effect |
|---|---|
| `PI_CODING_AGENT_DIR` | Check a different Pi install than `~/.pi/agent`. The CLI needs no session, so this is how you check a container, a second profile, or a Pi that will not boot at all |
| `PI_CHECKUP_IGNORE` | Suppress rows you have decided to live with — see below |
| `PI_CHECKUP_PROBE_URL` | Test real proxy *forwarding* with `curl`, instead of only proving the port is open. Only meaningful when a proxy variable below is set — without one there is nothing to forward through |
| `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, `all_proxy`, `ALL_PROXY` | The first one set is used by the provider probe (through `curl`, because Node's `fetch` ignores these) and reported redacted under Runtime. `NO_PROXY` is not consulted: the probe describes what Pi would do, and Pi ignores it too |

```text
$ npx pi-checkup
Registry
  · live registry      no Pi session — registry checks need a running process
Packages
  ✓ package dirs       13 present
  ✓ manifests          13 readable
  ✓ entry files        12 manifest(s) resolve
Binaries
  ✓ dangling links     19 links all resolve
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
  ✓ disk               6% used, 950.8 GB free
  ✓ proxy              http://127.0.0.1:10808 accepting connections

19 checks: 15 ok, 1 warning, 0 failed, 3 skipped
Run `npx pi-checkup --verbose` to show what to do about each finding.

! 1 warning  ·  run /checkup inside Pi for registry checks
```

## Real output

This is an actual run on a working install, copied out of the TUI at 80 columns — not a mock-up. The two `Network` rows describe the moment it ran; everything else is a property of the install. 21 of 24 checks pass, two are skipped because there is genuinely nothing to look at, and the one warning is a real problem that `pi list` said nothing about:

```text
Registry
  ✓ tools              49 registered (39 extension, 10 builtin) across 12
                       sources
  ✓ commands           94 registered across 20 sources, 0 MCP server(s)
  ✓ attribution        49 tool(s) from 12 source(s): pi-lens (13), builtin (10),
                       pi-web-access (5), pi-subagents (5) +8 more
  ✓ tool collisions    none
  ✓ command collisions none
  ✓ silent packages    none
Packages
  ✓ package dirs       13 present
  ✓ manifests          13 readable
  ✓ entry files        12 manifest(s) resolve
Binaries
  ✓ dangling links     19 links all resolve
  ✓ shadowed names     none
  ! unreachable bins   6 package command(s) not on PATH: pi-web-access-mcp,
                       pi-subagents, pi-mcp-adapter, pi-lens, pi-lens-mcp,
                       pi-lens-analyze
Network
  ✓ providers          2 endpoint(s) reachable
  ✓ dns                1 provider host(s) resolve normally
Config
  ✓ settings.json      valid JSON (values read from the running session)
  ✓ models.json        valid JSON
  · project settings   none
  ✓ backups            2 file(s) backed up; edited since the newest backup:
                       settings.json
  ✓ duplicate packages none
  · env references     no $VAR reference in models.json credentials
Runtime
  ✓ node               v22.23.3
  ✓ pi launcher        /root/.pi/agent/bin/pi
  ✓ disk               6% used, 950.8 GB free
  ✓ proxy              http://127.0.0.1:10808 accepting connections

24 checks: 21 ok, 1 warning, 0 failed, 2 skipped
Run `/checkup verbose` to show what to do about each finding.
```

The `attribution` row is the part no other tool gives you: which package owns which tools, counted from the live registry rather than from your config. Both blocks above share the same 23-column detail column, because `duplicate packages` and `command collisions` are both 18 characters wide and the renderer sizes the column to the longest title in the report it is printing, up to a 22-character cap after which the detail moves to its own line.

## What it checks

| Group | Finding | Why it matters |
|---|---|---|
| **Registry** | Tool and command collisions | One extension silently stops being reachable; the later registration wins with no error |
| | Silent packages | Declared an extension but registered no tool or command — either by design or a load failure |
| | Attribution | Which package owns each of your tools and commands, by name |
| **Packages** | Package list | Whether `settings.json` could be read at all — a hand-edited file that does not parse is reported as unreadable, not as "no packages" |
| | Missing directories | In `settings.json` but gone from `node_modules` |
| | Corrupt manifests | A `package.json` that parses as nothing — reported as a failure, because the package cannot load |
| | Unreadable manifests | A `package.json` this process could not read (permissions, or larger than the 4 MB limit). Reported as a warning: unproven, not broken |
| | Missing entry files | The manifest points at a build output that was never shipped |
| | Not a package | A `packages` entry that points at a file instead of a directory. Reported without a repair: there is nothing to delete |
| | Unverifiable sources | `git:` and `https:` packages, which Pi resolves internally and no static check can follow |
| | Malformed entries | A `packages` entry that is not a source string — `null`, a number, an object without `source` |
| | Unreadable directories | A package directory that exists but cannot be listed, which is a permission problem rather than a missing install |
| | Manifest shape | A `pi.extensions` entry that is not a string, so the entry files for that package could not be checked |
| **Binaries** | Bin directory | Whether `.bin` could be listed at all — a missing `.bin` is a `skip` that still names the commands it should have held, an unreadable one is a warning |
| | Dangling links | A symlink whose target is gone — a blocked `postinstall`, or an optional native dependency skipped for this platform. Only links are counted, so a Windows `.bin` of plain shim files reports `skip` instead of a green tick over nothing |
| | Unreadable links | A link that exists but cannot be followed (permissions, a loop) — reported, not called broken |
| | Install leftovers | `.<name>-<random>` staging links in `.bin`: an install is running right now, or was interrupted. Its own finding, not a broken package |
| | Missing shims | The package declares a `bin` but npm never linked it into `.bin` — usually an install run with `--ignore-scripts` |
| | Shadowed names | A package's command name resolves to an unrelated program earlier on `PATH` |
| | Unreachable bins | A package ships a CLI you cannot invoke by name |
| **Network** | Endpoint reachability | Probes `<baseUrl>/models` for every provider. `401`/`403` counts as alive — this never validates your key and never spends tokens |
| | Cleartext auth | A provider on `http://` with a credential configured — an `apiKey`, or a password embedded in the `baseUrl`. The probe is sent without either, and the config is reported instead |
| | Malformed baseUrl | A `baseUrl` that is not a URL (including the `localhost:11434/v1` paste with no scheme) or is not a string at all |
| | DNS | Provider hosts that do not resolve, or resolve only to loopback |
| **Config** | Invalid JSON | With a backup on disk, `/checkup fix` can restore it |
| | Duplicate package entries | The package loads twice and the second registration can shadow the first |
| | Unset env references | `$NAME` / `${NAME}` in the `models.json` fields Pi actually interpolates (`apiKey`, header values) with nothing in the environment |
| | Backups | Whether a broken config could be recovered at all |
| **Runtime** | Agent directory | Whether the directory being inspected exists at all — without it every other row skips, which would otherwise read as a clean install |
| | Node version, launcher, disk, proxy | The host conditions Pi itself needs |
| **Any** | Crashed or timed-out module | A check that threw or ran past 30s is reported as a failure naming the module, and every other section still prints |

## `/checkup fix`

Only reversible repairs are automated, and inside a session it normally offers only the first:

1. **Restore a config file** that is no longer valid JSON, from its newest sibling backup. The broken copy is kept.

2. **Collapse duplicate `packages` entries** in `settings.json`. Only byte-identical repeats are dropped: `"npm:a"` next to `{"source": "npm:a", "enabled": false}` carries different intent and is left alone.
3. **Prune `packages` entries whose directory is gone** — the ones a reinstall did not bring back. Sources resolved by Pi itself (`git:`, `https:`) are never touched, and a prune that would remove *every* entry is refused: that pattern means the agent directory is wrong, not that every package vanished.

Repairs 2 and 3 rewrite `settings.json`, so they need a settings file checkup actually read. Inside a session Pi hands checkup the settings from the *running process*, not the file on disk, and checkup will not rewrite a file it never read — so `/checkup fix` in-session offers repair 1, plus the other two only when Pi could not supply the settings and checkup fell back to reading the file. Stop Pi and run the CLI to be sure:

```bash
npx pi-checkup --fix --yes
```

Every write is preceded by a timestamped backup, and neither path writes on its own: `/checkup fix` asks in the TUI, and the CLI refuses to write unless you pass `--yes`. Anything that would delete a package, disable an extension, or edit your shell environment is reported with a suggestion and left alone — a diagnostic tool should not be able to break your setup in the process of describing it.

A repair that rewrites `settings.json` re-serialises it with two-space indentation, so expect a larger diff than the change itself. Nothing is repaired unless a check found something wrong, so a healthy install writes nothing at all.

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

`/checkup json` prints the report as one object, delivered as a TUI notification — good for pasting into a bug report. For a pipe, use `npx pi-checkup --json`, which writes the same object to stdout, stamped with the version and platform that produced it. Two of the 24 entries are shown here:

```json
{
  "summary": { "total": 24, "ok": 21, "warn": 1, "fail": 0, "skip": 2 },
  "version": "0.1.0",
  "node": "22.23.3",
  "platform": "linux",
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

The `checks` array always has one entry per row of the text report, in the same order. The excerpt above is trimmed for width; real output is printed by `JSON.stringify(payload, null, 2)`.

Exit-worthy statuses are `fail`; `warn` means something is degraded but working. Repair metadata is stripped from the JSON payload.

## Design principles

- **No traffic to anyone but your own provider.** The only outbound requests are `<baseUrl>/models` for providers already in `models.json`, plus a DNS lookup of those same hosts. The proxy check is a plain TCP connect to the proxy's own address — set `PI_CHECKUP_PROBE_URL` if you want a real end-to-end forwarding test.
- **No secrets printed, no keys validated.** A provider probe sends whatever auth header your config already defines and ignores the response body. A key on a plain-`http://` endpoint that is not on your own machine is never sent. A proxy URL is reduced to scheme, host and port — or `(configured)` when it carries credentials — and a `git:` source carrying a token is scrubbed the same way: corporate proxies and private repos both keep credentials in the URL, and both are the kind of string that ends up in a CI log. A `baseUrl` with credentials in it is moved into a header before the probe, so no error message can quote it back; over plain `http://` to another machine it is dropped instead, and the row says so.
- **Non-blocking.** Every check runs concurrently, and every outbound call has its own timeout — 6s for a curl probe, 8s for a fetch probe, 4s for DNS, 3s for a TCP connect — under a 30s per-module backstop. A hung endpoint costs one timeout, or two when a configured proxy fails and the direct path is tried as well, and never the whole command.
- **A crashing check is a finding, not a crash.** If a check module throws, the report says which one, marks it failed, and still shows everything else.
- **A check with nothing to inspect says so.** `skip` means nothing was inspected — an absent optional config file, an empty `.bin`, a provider list with no host to resolve, or a row you suppressed with `PI_CHECKUP_IGNORE` (whose detail says what it replaced). Zero packages present reports `skip`, never a green tick over nothing, and the verdict counts them: `✓ 3 ok, 2 skipped` rather than a bare "all clear".
- **Cross-platform.** Node built-ins only. `PATH` is resolved in-process against `PATHEXT` on Windows and the executable bit on POSIX, so a minimal container without `which` still works; `/dev/null` vs `NUL` for curl output, symlinked package stores, and path separators are handled. Checks that cannot run are marked skipped rather than failed.
- **Zero dependencies.** Nothing to audit, nothing to break on a Pi upgrade.

## Known limitations

Being explicit about what this cannot see:

- **Extension load errors are not exposed to extensions.** Pi's own `LoadExtensionsResult.errors` is not reachable from the extension API, so "which extension threw during load" is inferred statically (declared but unregistered), not read directly.
- **`git:` and URL package sources are not inspected.** Pi resolves them internally; static probing cannot follow them, so they are reported as `unverifiable` rather than guessed at.
- **The registry section needs a running session.** Tools and commands are read from the live process; the CLI reports that section as skipped rather than guessing from disk.
- **Tool collisions are reported, not resolved.** Pi's registry keeps the last registration; checkup tells you it happened.
- **The proxy check proves the port is open, not that forwarding works.** A TCP connect tells you the process is running; it says nothing about whether it can reach a given target. Set `PI_CHECKUP_PROBE_URL` for the full test, which uses `curl`.
- **A proxied provider probe needs `curl`.** Node's `fetch` ignores `https_proxy`, so when a proxy is configured the probe shells out to `curl`, which honours it. Without `curl` on `PATH` that row reports `skip` with the reason instead of inventing a reachability failure.
- **Static checks describe the current session.** Install a package and the registry section is stale until `/reload`.
- **A DNS lookup that hangs can outlive the report.** `resolveHost` races the lookup against a 4s deadline so the report is never held hostage, but Node's pending `getaddrinfo` request can keep the process alive for a while after the verdict is printed. The report is complete and correct; the exit is merely later than it looks.
- **A run that overlaps an install describes a moving target.** Half-extracted packages and npm's staging links in `.bin` are visible for a second or two; checkup reports them as install leftovers and suggests re-running once the install finishes, but it cannot wait for it.

## Development

```bash
git clone https://github.com/xinghe-labs/pi-checkup
cd pi-checkup
npm run lint         # node --check over every source file
node --test          # the whole suite; no Pi session needed
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
  repair.js          the only module that writes to user files
  util.js            cross-platform helpers, no dependencies
  checks/
    index.js         the check registry, shared by command and CLI
    registry.js      what is loaded, who owns it, what collided
    packages.js      installed vs present vs loadable
    binaries.js      PATH reachability and shadowing
    network.js       provider endpoints and DNS
    config.js        JSON validity, backups, duplicates, env refs
    runtime.js       node, launcher, disk, proxy
test/
  *.test.js          node --test, no Pi session needed
scripts/
  lint.js            node --check over every source file (`npm run lint`)
```

Adding a check: export `group` and `run(ctx)`, return an array of `{ group, id, title, status, detail, hint? }`, and add the module to the `CHECKS` array in `src/checks/index.js`.

`ctx` carries everything a check may read — `agentDir`, `settingsFile`, `projectSettingsFile`, `modelsFile`, `binDir`, `settings`, `settingsSource`, `env`, `offline`, `hasRuntime`, `pi`, `cwd` — so no check reads the process environment or a path on its own. Tests point `agentDir` at a temp directory; see `test/checks.test.js`.

## License

MIT
