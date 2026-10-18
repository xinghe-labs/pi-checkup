# pi-checkup

**`pi list` tells you what you installed. `pi-checkup` tells you what actually works.**

A health-check extension for [Pi](https://pi.dev). It inspects the *running* session — not just your `settings.json` — and reports the failures that produce no error message anywhere: tools silently shadowed by another package, binaries that resolve to a completely different program, packages that are installed but registered nothing, endpoints that stopped answering.

## Install

```bash
pi install npm:pi-checkup
```

Start a new session afterwards (or run `/reload` in a running one): a package
installed mid-session is not loaded until Pi re-reads its package list.

Then, in a session:

```text
/checkup            run every check
/checkup verbose    same, plus what to do about each finding
/checkup json       machine-readable report
/checkup fix        apply the available repairs (asks first)
```

## The problem

A Pi install accumulates packages. Each one registers tools, commands, hooks, and sometimes shell binaries. When one of them stops working, nothing tells you:

- Two packages claimed the same tool name, and the second one silently won. The first is now unreachable.
- A package is in `settings.json`, its directory exists, but its manifest points at a file that isn't there. It loaded nothing and logged nothing.
- `ast-grep` ships a binary named `sg`. So does the shadow-utils package. Typing `sg` starts the wrong one.
- A blocked `postinstall` left `node_modules/.bin/playwright` as a dangling symlink.
- Your provider endpoint moved. The only symptom is a request that hangs, then fails.

`pi list` prints paths. `pi --verbose` prints warnings you have to read line by line. Neither answers *"is my setup actually coherent right now?"*

## The standalone CLI

The in-session command is useless in the one case you need it most: Pi is installed but will not boot. The same checks also ship as a CLI that needs no session, no Pi, and no `node_modules` — which is also what you want in CI, or on a machine you are about to hand over.

One difference to know before you read the first CLI report: the registry section — collisions, silent packages, attribution — is read from the live process, so the CLI marks it skipped. Everything else runs without a session: packages, binaries, network, config, runtime. On a machine where Pi has never been started, most rows have nothing to inspect and say so rather than passing.

```bash
npx pi-checkup              # full report
npx pi-checkup --verbose    # same report, plus the hint under every finding
npx pi-checkup --offline    # skip every network probe
npx pi-checkup --json       # for scripts
npx pi-checkup --fix        # list the available repairs
npx pi-checkup --fix -y     # apply them (nothing is written without -y)
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
| `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, `all_proxy`, `ALL_PROXY` | The first one set is used by the provider probe (through `curl`, because Node's `fetch` ignores these) and reported redacted under Runtime. The probe runs with `--noproxy ''`, so a `NO_PROXY` entry cannot route it around the proxy it is meant to test — and Pi's own `fetch` ignores `NO_PROXY` too |

```text
$ npx pi-checkup
Registry
  · live registry      no Pi session — registry checks need a running process
Packages
  ✓ package dirs       14 present
  ✓ manifests          14 readable
  ✓ entry files        13 manifest(s) resolve
Binaries
  ✓ dangling links     19 links all resolve
  · shadowed names     no package command resolved on PATH
  · unreachable bins   6 package command(s) live in
                       /root/.pi/agent/npm/node_modules/.bin, which is not on
                       PATH: pi-web-access-mcp, pi-subagents, pi-mcp-adapter,
                       pi-lens, pi-lens-mcp, pi-lens-analyze
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
  ✓ disk               6% used on /, 950.4 GB free
  ✓ proxy              http://127.0.0.1:10808 accepting connections

19 checks: 14 ok, 0 warnings, 0 failed, 5 skipped
Run `npx pi-checkup --verbose` to show what to do about each finding.

✓ 14 ok, 5 skipped  ·  run /checkup inside Pi for registry checks
```

Both captures below and above come from a real machine, taken with pi-checkup 0.1.0; free space, Node versions and which packages are installed are properties of that machine, not of the tool, and the row counts grow when checks are added.

## Real output

This is an actual run on a working install, copied out of the TUI at 80 columns — not a mock-up. The two `Network` rows describe the moment it ran; everything else is a property of the install. 20 of 24 checks pass and the other four are skipped because there is genuinely nothing to look at: no live registry to audit, no project-level settings, no `$VAR` credentials, and no package command on `PATH` to compare. Nothing warns, which is the point — the package commands live in a `.bin` directory Pi never adds to `PATH`, that is Pi's own layout rather than a fault, and the row says so instead of putting a permanent amber mark on a healthy install.

```text
Registry
  ✓ tools              49 registered (39 extension, 10 builtin) across 12
                       sources
  ✓ commands           95 registered across 21 sources, 0 MCP server(s)
  ✓ attribution        49 tool(s) from 12 source(s): pi-lens (13), builtin (10),
                       pi-web-access (5), pi-subagents (5), ... 8 more
  ✓ tool collisions    none
  ✓ command collisions none
  ✓ silent packages    none
Packages
  ✓ package dirs       14 present
  ✓ manifests          14 readable
  ✓ entry files        13 manifest(s) resolve
Binaries
  ✓ dangling links     19 links all resolve
  · shadowed names     no package command resolved on PATH
  · unreachable bins   6 package command(s) live in
                       /root/.pi/agent/npm/node_modules/.bin, which is not on
                       PATH: pi-web-access-mcp, pi-subagents, pi-mcp-adapter,
                       pi-lens, pi-lens-mcp, pi-lens-analyze
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
  ✓ disk               6% used on /, 950.4 GB free
  ✓ proxy              http://127.0.0.1:10808 accepting connections

24 checks: 20 ok, 0 warnings, 0 failed, 4 skipped
Run `/checkup verbose` to show what to do about each finding.
```

The `attribution` row is the part no other tool gives you: which package owns which tools, counted from the live registry rather than from your config. Both blocks above share the same 23-column detail column, because `duplicate packages` and `command collisions` are both 18 characters wide and the renderer sizes the column to the longest title in the report it is printing, up to a 22-character cap after which the detail moves to its own line.

## What it checks

| Group | Finding | Why it matters |
|---|---|---|
| **Registry** | Live registry | No Pi session — the registry checks need a running process, so the whole section collapses to this one skipped row |
| | Tool and command collisions | One extension silently stops being reachable; the later registration wins with no error |
| | Silent packages | Declared an extension but registered no tool or command — either by design or a load failure |
| | Loaded tools and commands | How many registered, split by extension and builtin, and how many distinct sources they came from |
| | Attribution | Which package owns each of your tools, by name |
| **Packages** | Package list | Whether `settings.json` could be read at all — a hand-edited file that does not parse is reported as unreadable, not as "no packages" |
| | Missing directories | In `settings.json` but gone from `node_modules`. A version pin (`npm:name@1.2.3`) is resolved to the directory it installs into, not taken as part of the name |
| | Version pins | `settings.json` pins an exact version and a different one is installed — the code that runs is not the code that was asked for. Ranges and tags are not compared, because the installer is free to satisfy them |
| | Corrupt manifests | A `package.json` that parses as nothing — reported as a failure, because the package cannot load |
| | Missing manifests | The package directory exists but holds no `package.json` — an interrupted install, or a leftover folder. Its own row, because telling someone to check ownership of a directory that has no manifest sends them to fix the wrong thing |
| | Unreadable manifests | A `package.json` this process could not read (permissions, or larger than the 4 MB limit). Reported as a warning: unproven, not broken |
| | Missing entry files | The manifest points at a build output that was never shipped |
| | Not a package | A `packages` entry that points at a file instead of a directory. Reported without a repair: there is nothing to delete |
| | Unverifiable sources | `git:` and `https:` packages, which Pi resolves internally and no static check can follow |
| | Malformed entries | A `packages` entry that is not a source string — `null`, a number, an object without `source` |
| | Unreadable directories | A package directory that exists but cannot be listed, which is a permission problem rather than a missing install |
| | Manifest shape | A `pi.extensions` entry that is not a string. The string entries are still checked; only the malformed ones are left out |
| **Binaries** | Bin directory | Whether `.bin` could be listed at all — a missing `.bin` is a `skip` that still says how many commands it should have held, an unreadable one is a warning |
| | Dangling links | A symlink whose target is gone — a blocked `postinstall`, or an optional native dependency skipped for this platform. Only links are counted, so a Windows `.bin` of plain shim files reports `skip` instead of a green tick over nothing |
| | Unreadable links | A link that exists but cannot be followed (permissions, a loop) — reported, not called broken |
| | Install leftovers | `.<name>-<random>` staging links in `.bin`: an install is running right now, or was interrupted. Its own finding, not a broken package |
| | Missing shims | The package declares a `bin` but npm never linked it into `.bin` — usually an install run with `--ignore-scripts` |
| | Shadowed names | A package's command name resolves to an unrelated program earlier on `PATH`. Skipped when no declared command resolved at all: there is nothing to compare, and a green tick there would sit next to a row saying the commands are missing |
| | Unreachable bins | A package ships a CLI that is not reachable by name. A `skip` when `.bin` itself is not on `PATH` — that is Pi's own layout and Pi calls these by full path — and a warning only when the directory *is* on `PATH` and the command still did not resolve, which points at PATH order or an unreadable link |
| **Network** | Endpoint reachability | Probes `<baseUrl>/models` for every provider. `401`/`403` counts as alive — this never validates your key and never spends tokens. An endpoint that answers with something other than life — a refused connection, a rejected certificate, an HTTP error — is a failure, and fails the run; only a probe that was cut off locally by its own timeout stays a warning, because the deadline is this process's, not the endpoint's |
| | Cleartext auth | A provider on `http://` to another machine with a credential configured — an `apiKey`, a password embedded in the `baseUrl`, a credential-named header value, or a query string, which cannot be inspected for secrets. The `apiKey` and `baseUrl` credentials are withheld from the probe; a query string is never sent, so that endpoint is reported unprobed. Loopback hosts are exempt |
| | baseUrl shape | A `baseUrl` that is not a string or an object. A string that is not a URL — including the `localhost:11434/v1` paste with no scheme — is reported as an unhealthy provider, and also named in this row, because the endpoint is what would have to be probed |
| | DNS | Provider hosts that do not resolve, or resolve only to loopback |
| **Config** | Invalid JSON | With a backup on disk, `/checkup fix` can restore it |
| | Duplicate package entries | The package loads twice and the second registration can shadow the first |
| | Unset env references | `$NAME` / `${NAME}` in the `models.json` fields Pi actually interpolates (`apiKey`, header values) with nothing in the environment |
| | Backups | Whether a broken config could be recovered at all |
| **Runtime** | Agent directory | Whether the directory being inspected exists and can be listed — without it most other rows skip, which would otherwise read as a clean install |
| | Node version, launcher, disk, proxy | The host conditions Pi itself needs |

The groups above are the ones that appear in a report, in that order. Independent of them: a check that throws, or runs past 30 seconds, is reported as a failure naming the module, and every other section still prints.

## `/checkup fix`

Only reversible repairs are automated, and inside a session it normally offers only the first:

1. **Restore a config file** that is no longer valid JSON, from its newest sibling backup that still parses — a corrupt newest backup does not block the valid one beside it, and the message says how many newer ones were skipped. The broken copy is kept.

2. **Collapse duplicate `packages` entries** in `settings.json`. Only byte-identical repeats are dropped: `"npm:a"` next to `{"source": "npm:a", "enabled": false}` carries different intent and is left alone.
3. **Prune `packages` entries whose directory is gone** — the ones a reinstall did not bring back. Sources resolved by Pi itself (`git:`, `https:`) are never touched, and a prune that would leave the list empty is refused and never even offered: that pattern means the agent directory is wrong, not that every package vanished.

Repairs 2 and 3 rewrite `settings.json`, so they need a settings file checkup actually read. Inside a session Pi hands checkup the settings from the *running process*, not the file on disk, and checkup will not rewrite a file it never read — so `/checkup fix` in-session offers repair 1, plus the other two only when Pi returned no settings and checkup read the file itself. If `getSettings()` threw, the fallback is still unverified and neither rewrite is offered. Stop Pi and run the CLI to be sure:

```bash
npx pi-checkup --fix --yes
```

Every write is preceded by a timestamped backup — one per file per run, taken before the first write, so `restore` hands back the file as it was before checkup ran rather than a half-repaired intermediate — and neither path writes on its own: `/checkup fix` asks in the TUI, and the CLI refuses to write unless you pass `--yes`. Anything that would delete a package, disable an extension, or edit your shell environment is reported with a suggestion and left alone — a diagnostic tool should not be able to break your setup in the process of describing it.

A repair that rewrites `settings.json` re-serialises it with two-space indentation, so expect a larger diff than the change itself. Nothing is repaired unless a check found something wrong, so a healthy install writes nothing at all.

## Ignoring a finding you have decided to live with

Some findings are correct and permanent: a gateway you deliberately reach over plain `http` on your own network, a package installed with `--ignore-scripts` whose links you do not want. A health check you have learned to ignore is worse than no health check, so rows can be suppressed by name.

```bash
PI_CHECKUP_IGNORE=Network:cleartext npx pi-checkup
```

Each entry matches a row's `id`, its `Group:id` form, or its title. A suppressed row is downgraded to `skip`, keeps its original detail, and says what it replaced — here from a scratch install with one provider deliberately configured over plain `http`:

```text
  · cleartext auth     ignored via PI_CHECKUP_IGNORE (would be warn): gw use
                       http:// with credentials configured
```

Suppression is never silent, and it drops the row's repair offer so a hidden finding cannot be fixed behind your back. It applies to failures too: a suppressed `fail` no longer affects the exit code, which is the point of the variable — use it for a state you have decided to accept, not to turn a red build green. Export it from your shell profile if you want it to apply inside Pi too.

## JSON output

`/checkup json` prints the report as one object, delivered as a TUI notification — good for pasting into a bug report. For a pipe, use `npx pi-checkup --json`, which writes the same object to stdout, stamped with the version and platform that produced it. The excerpt below is from `/checkup json` inside a session — 24 entries, because the registry section has something to read there; in the CLI that section collapses to a single skipped row. Two of the entries, and the summary, are shown here:

```json
{
  "summary": {
    "total": 24,
    "ok": 20,
    "warn": 0,
    "fail": 0,
    "skip": 4
  },
  "version": "0.1.0",
  "node": "22.23.3",
  "platform": "linux",
  "checks": [
    {
      "group": "Binaries",
      "id": "unreachable",
      "title": "unreachable bins",
      "status": "skip",
      "detail": "6 package command(s) live in /root/.pi/agent/npm/node_modules/.bin, which is not on PATH: pi-web-access-mcp, pi-subagents, pi-mcp-adapter, pi-lens, pi-lens-mcp, pi-lens-analyze",
      "hint": "Pi calls these by full path, so an extension that uses them still works. Add /root/.pi/agent/npm/node_modules/.bin to PATH only if you want to run them by name."
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

The `checks` array always has one entry per row of the text report, in the same order. The excerpt above omits the other 22 entries; real output is printed by `JSON.stringify(payload, null, 2)`.

Exit-worthy statuses are `fail`; `warn` means something needs attention without by itself failing the run — an `apiKey` that no HTTP request can carry, or a credential on a plain-`http` endpoint. Repair metadata is stripped from the JSON payload.

## Design principles

- **No traffic to anyone but your own provider.** The only outbound requests are `<baseUrl>/models` for providers already in `models.json`, plus a DNS lookup of those same hosts. The proxy check is a plain TCP connect to the proxy's own address — set `PI_CHECKUP_PROBE_URL` if you want a real end-to-end forwarding test.
- **No secrets printed, no keys validated.** A provider probe sends the `apiKey` — or the `baseUrl` credentials, moved into an `Authorization` header — that your config defines, and ignores the response body. Custom `headers` are not replayed. A key on a plain-`http://` endpoint that is not on your own machine is never sent, and neither is a query string there — `?key=…` gateways are a real shape, and a query cannot be inspected for secrets. A proxy URL is reduced to scheme, host and port, and a value that is nothing but a credential prints `(configured)`; a `git:` source carrying a token is scrubbed the same way: corporate proxies and private repos both keep credentials in the URL, and both are the kind of string that ends up in a CI log. A `baseUrl` with credentials in it is moved into a header before the probe, so no error message can quote it back; over plain `http://` to another machine it is dropped instead, and the row says so. A header value that cannot be sent at all — a newline, a character above Latin-1 — is never sent through either path and is never quoted back: the row says the request could not be built and points at `models.json`.
- **Non-blocking.** Every check runs concurrently, and every outbound call has its own timeout — 6s for a curl probe, 8s for a fetch probe, 4s for DNS, 3s for a TCP connect — under a 30s per-module backstop. A hung endpoint costs one timeout, or two when a configured proxy fails and the direct path is tried as well, and never the whole command.
- **A crashing check is a finding, not a crash.** If a check module throws, the report says which one, marks it failed, and still shows everything else.
- **A check with nothing to inspect says so.** `skip` means nothing was inspected — an absent optional config file, an empty `.bin`, a provider list with no host to resolve, or a row you suppressed with `PI_CHECKUP_IGNORE` (whose detail says what it replaced). Zero packages present reports `skip`, never a green tick over nothing, and the verdict counts them: `✓ 3 ok, 2 skipped` rather than a bare "all clear".
- **Cross-platform.** Node built-ins only. `PATH` is resolved in-process against `PATHEXT` on Windows and the executable bit on POSIX, so a minimal container without `which` still works; `/dev/null` vs `NUL` for curl output, symlinked package stores, and path separators are handled. A check that finds nothing to inspect is marked skipped rather than failed — but a check module that throws or runs past its 30s backstop is a failure, because something was supposed to be inspected and was not.
- **Zero dependencies.** Nothing to audit, nothing to break on a Pi upgrade.

## Known limitations

Being explicit about what this cannot see:

- **Extension load errors are not exposed to extensions.** Pi's own `LoadExtensionsResult.errors` is not reachable from the extension API, so "which extension threw during load" is inferred statically (declared but unregistered), not read directly.
- **`git:` and URL package sources are not inspected.** Pi resolves them internally; static probing cannot follow them, so they are reported as `unverifiable` rather than guessed at.
- **Only the personal agent directory is audited.** A project's `.pi/settings.json` is checked for parseability, but the packages it declares are not resolved: where a project installs them is Pi's decision, and guessing the path produced "missing" claims that were not true.
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

`ctx` carries everything a check may read — `agentDir`, `settingsFile`, `projectSettingsFile`, `modelsFile`, `binDir`, `settings`, `settingsLoaded`, `settingsSource`, `env`, `offline`, `hasRuntime`, `agentDirExplicit`, `pi`, `cwd` — so no check reads the process environment or a path on its own. Tests point `agentDir` at a temp directory; see `test/checks.test.js`.

## License

MIT
