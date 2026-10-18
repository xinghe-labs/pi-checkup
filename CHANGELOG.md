# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-18

Fourteen defects found by auditing the report and the redactors against adversarial input rather
than by reading them.

### Security

- A bare token is masked. `scrubCredentials` only knew userinfo and query strings, so an error
  message quoting a key — `extension load failed for provider openai with apiKey sk-…` — printed 63
  of the 64 key characters into the report, the TUI notification and `--json`; the 64th was cut by
  the caller's own 120-character slice. Known prefixes (`sk-`, `ghp_`, `npm_`, `xox`, `AKIA`,
  `AIza`, JWTs), `Bearer` values, and the value after a credential-named key are masked now.
- `redactUrl` no longer republishes a credential that sits in the URL path. A gateway that takes
  its key in the path — `https://host/ghp_…/v1` — had it printed by the one function whose job is
  to keep it out.

### Fixed

- `restore` undoes the repair run. Two repairs that touched the same file each wrote their own
  backup milliseconds apart, so the newest backup — the one `restore` picks — held the intermediate
  state. Breaking the config after a `--fix` run and restoring it handed back a half-repaired file.
  One backup per file per run now, taken before the first write.
- A corrupt newest backup no longer blocks a valid older one. Restore took only the newest backup
  and gave up when it did not parse, which failed the one case recovery exists for. Backups are
  walked newest-first and the first that parses wins, with the skipped count in the message.
- Wrapping measures display columns, not code units. A CJK path is one code unit and two terminal
  columns per character, so a Chinese or Japanese install path wrapped one column short and spilled
  past the 80 the report promises.
- The report's own summary and footer respect the width. On a 40- or 50-column terminal those two
  lines overflowed while every row wrapped.
- A `package.json` that parses to a non-object (`null`, `"nope"`, `[]`) is a failure, not "readable".
  It showed a green tick for a package that cannot load, next to an `entry files` row that skipped
  because the manifest declared nothing. An empty object still counts as readable.
- The registry source count covers every entry. Deriving it from the named-only attribution map
  printed "2 registered … across 0 sources" when no entry carried a name, and understated a
  partly-named registry. The attribution row now also says how many entries it could not attribute.
- Three copies of one entry are not "1 listed twice". The duplicate count was a set of sources, so
  it never grew past the number of sources involved.
- A scheme-less IPv4 proxy (`127.0.0.1:10808`) is probed. `new URL` throws on it because a scheme
  cannot start with a digit, and the early return skipped the textual fallback that exists for
  exactly that shape — while `proxy.corp:8080` parsed and was probed. Same env value, two verdicts.
- A proxy value that is only a credential is no longer announced as `configured ((configured))`.
- A directory named `bin/pi` is not reported as a working launcher. `exists()` is true for a
  directory and a directory is usually 0755, so both halves of the check passed.

## [0.1.1] - 2026-10-18

### Fixed

- A healthy install no longer carries a permanent warning. The `unreachable bins` row was always a
  warning, but Pi never puts `.bin` on `PATH` and resolves package commands by full path — so every
  healthy install carried an amber mark forever. It is a `skip` when the directory is off `PATH`
  (the layout, stated as such) and a warning only when the directory *is* on `PATH` and the command
  still did not resolve.
- The stale-backup hint states what is true. It said "because both backups are older", which was
  hardcoded and wrong the moment one file was stale and the other was not. It now says the newest
  backup predates the current file, so restoring it would discard the edits made since.

## [0.1.0] - 2026-10-18

First release.

### Added

- Six check groups — Registry, Packages, Binaries, Network, Config, Runtime — with 24 rows in a
  live session and 19 from the CLI.
- `/checkup` inside Pi and `npx pi-checkup` outside it, sharing one report formatter so the two
  cannot disagree about what was found.
- `--verbose`, `--json`, `--offline`, `--fix [--yes]`, `--help`, `--version`.
- Registry auditing that a shell script cannot do: which package owns which tool, tool and command
  collisions, and packages that declared an extension but registered nothing.
- Three reversible repairs — restore a config from a sibling backup, collapse byte-identical
  duplicate `packages` entries, prune entries whose directory is gone. Every write is atomic, keeps
  the original mode, and is preceded by a timestamped backup. `/checkup fix` asks first; the CLI
  refuses to write without `--yes`. Nothing deletes a package or disables an extension.
- `PI_CHECKUP_IGNORE`, `PI_CHECKUP_PROBE_URL`, `PI_CODING_AGENT_DIR`, and the proxy variables.
- Windows support: `PATHEXT` resolution, `.cmd` shims, `NUL` instead of `/dev/null`, and path
  separators. CI runs the suite on Ubuntu, macOS and Windows across Node 20 and 22.

### Notes

- Zero runtime dependencies.
- No traffic to anyone but the provider endpoints already in `models.json`, plus a DNS lookup of
  those same hosts. The proxy check is a plain TCP connect to the proxy's own address unless
  `PI_CHECKUP_PROBE_URL` opts into a real forwarding test.

[Unreleased]: https://github.com/xinghe-labs/pi-checkup/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/xinghe-labs/pi-checkup/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/xinghe-labs/pi-checkup/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xinghe-labs/pi-checkup/releases/tag/v0.1.0
