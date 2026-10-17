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

## Real output

This is an actual run on a working install — 21 of 24 checks pass, and the three warnings are all real problems that `pi list` showed nothing about:

```text
Registry
  ✓ tools            49 registered (39 extension, 10 builtin) across 12 sources
  ✓ commands         94 registered across 20 sources, 0 MCP server(s)
  ✓ tool collisions  none
  ✓ command collisions none
  ✓ silent packages  none
Packages
  ✓ package dirs     13 present
  ✓ manifests        all readable
  ✓ entry files      all present
Binaries
  ✓ dangling links   19 entries all resolve
  ! shadowed names   playwright-cli resolves to /mnt/d/npm/npm-global/playwright-cli; sg resolves to /usr/bin/sg
      Running the bare name in a shell starts a different program. Call the package binary by full path, or reorder PATH.
  ! unreachable bins 6 package command(s) not on PATH: pi-lens, pi-lens-analyze, pi-lens-mcp, pi-mcp-adapter, pi-subagents, pi-web-access-mcp
      Extensions that call these by full path still work; you and the agent cannot invoke them by name.
Network
  ✓ me               https://sub.example.com reachable (HTTP 200)
  ✓ workbuddy        http://127.0.0.1:7863 reachable (HTTP 200)
  ✓ dns              2 provider host(s) resolve normally
Config
  ✓ settings.json    valid JSON
  ✓ models.json      valid JSON
  ✓ project settings none
  ✓ backups          present for every config file
  ✓ duplicate packages none
  ✓ env references   all set
Runtime
  ✓ node             v22.23.3
  ✓ pi launcher      ~/.pi/agent/bin/pi
  ✓ disk             6% used, 951.1 GB free
  ✓ proxy            http://127.0.0.1:10808 reachable (HTTP 401)

24 checks: 21 ok, 2 warning, 0 failed
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
| | Shadowed names | A package's command name resolves to an unrelated program earlier on `PATH` |
| | Unreachable bins | A package ships a CLI you cannot invoke by name |
| **Network** | Endpoint reachability | Probes `<baseUrl>/models` for every provider. `401`/`403` counts as alive — this never validates your key and never spends tokens |
| | DNS | Provider hosts that do not resolve, or resolve only to loopback |
| **Config** | Invalid JSON | With a backup on disk, `/checkup fix` can restore it |
| | Duplicate package entries | The package loads twice and the second registration can shadow the first |
| | Unset env references | `$NAME` / `${NAME}` in settings with nothing in the environment |
| **Runtime** | Node version, launcher, disk, proxy | The host conditions Pi itself needs |

## `/checkup fix`

Only two repairs are automated, both reversible:

1. **Restore a config file** that is no longer valid JSON, from its newest sibling backup. The broken copy is kept.
2. **Collapse duplicate `packages` entries** in `settings.json`.

Every write is preceded by a timestamped backup, and the command asks for confirmation before touching anything. Anything that would delete a package, disable an extension, or edit your shell environment is reported with a suggestion and left alone — a diagnostic tool should not be able to break your setup in the process of describing it.

## JSON output

`/checkup json` prints the full report for scripts and CI:

```json
{
  "summary": { "total": 24, "ok": 22, "warn": 2, "fail": 0, "skip": 0 },
  "checks": [
    {
      "group": "Binaries",
      "id": "shadowed",
      "title": "shadowed names",
      "status": "warn",
      "detail": "sg resolves to /usr/bin/sg"
    }
  ]
}
```

Exit-worthy statuses are `fail`; `warn` means something is degraded but working.

## Design principles

- **No network egress beyond your own provider endpoints.** The only outbound requests are `<baseUrl>/models` for providers already in `models.json`, plus a DNS lookup of those same hosts.
- **No secrets printed, no keys validated.** A provider probe sends whatever auth header your config already defines and ignores the response body.
- **Non-blocking.** Every check runs concurrently with a hard timeout. A hung endpoint costs 8 seconds, not the whole command.
- **A crashing check is a finding, not a crash.** If a check module throws, the report says which one and still shows everything else.
- **Cross-platform.** Node built-ins only. `which`/`where`, `curl` vs `NUL`, and path separators are handled; checks that cannot run are marked skipped rather than failed.
- **Zero dependencies.** Nothing to audit, nothing to break on a Pi upgrade.

## Known limitations

Being explicit about what this cannot see:

- **Extension load errors are not exposed to extensions.** Pi's own `LoadExtensionsResult.errors` is not reachable from the extension API, so "which extension threw during load" is inferred statically (declared but unregistered), not read directly.
- **`git:` and URL package sources are not inspected.** Pi resolves them internally; static probing cannot follow them, so they are reported as `unverifiable` rather than guessed at.
- **Tool collisions are reported, not resolved.** Pi's registry keeps the last registration; checkup tells you it happened.
- **The proxy probe needs `curl`.** Without it the check reports skipped instead of failing.
- **Static checks describe the current session.** Install a package and the registry section is stale until `/reload`.

## Development

```bash
git clone https://github.com/CHANGE_ME/pi-checkup
cd pi-checkup
node --test          # unit tests, no Pi session needed
```

To try a local checkout without installing:

```bash
pi -e ./src/index.js
```

Layout:

```text
src/
  index.js           command registration, fix flow
  render.js          one formatter for text and JSON
  util.js            cross-platform helpers, no dependencies
  checks/
    registry.js      what is loaded, who owns it, what collided
    packages.js      installed vs present vs loadable
    binaries.js      PATH reachability and shadowing
    network.js       provider endpoints and DNS
    config.js        JSON validity, backups, duplicates  (+ the two repairs)
    runtime.js       node, launcher, disk, proxy
```

Adding a check: export `group` and `run(ctx)`, return an array of `{ group, id, title, status, detail, hint? }`, and register the module in `src/index.js`.

## License

MIT
