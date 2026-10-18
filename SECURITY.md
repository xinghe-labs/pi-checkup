# Security policy

`pi-checkup` reads `models.json`, which holds API keys, and prints a report that is meant to be
pasted into issues and chat. A leak through that path is the most serious bug this package can have,
so it gets its own policy.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting:
<https://github.com/xinghe-labs/pi-checkup/security/advisories/new>

If that is unavailable, open a public issue that says only "I have a security report" and no
details, and a maintainer will open a private channel.

Please include the input that triggers it (a `models.json` or `settings.json` shape is usually
enough) and the command that printed it. If the input contains a real credential, replace it with a
value of the same shape — the shape is what matters.

You should get an acknowledgement within a few days. There is no bounty; this is a small package
maintained in the open.

## What counts as a vulnerability

- **A credential reaching the report.** Any `apiKey`, `Authorization` value, proxy password, or
  token appearing in the text report, the TUI notification, or the `--json` payload.
- **A credential reaching a third party.** The only outbound requests are `<baseUrl>/models` for
  providers already in `models.json` and a DNS lookup of those hosts. A request to anywhere else, or
  a credential sent to an endpoint the config did not designate, is a vulnerability.
- **A write that damages a config file.** Repairs must be atomic, must back up first, and must
  refuse rather than guess. A `--fix` that leaves a file unparsable is a vulnerability.
- **Command execution.** A value from `models.json` or `settings.json` reaching a shell.

## What does not

- **A key being sent to its own provider.** That is the check working: the probe asks
  `<baseUrl>/models` with the configured credential and ignores the body. It never validates the
  key and never spends tokens.
- **The value `(configured)` or `(value hidden)` in a report.** A proxy URL that is nothing but a
  token is replaced by that placeholder on purpose.
- **A hostname, path, or scheme appearing in a report.** `redactUrl` keeps scheme, host, port and
  path, and drops userinfo and the query string. A key in the *path* is masked; the host is not
  secret.

## Design constraints a fix must keep

These are why the code looks the way it does, and a patch that breaks one will be asked to change:

- Every string from a config file passes through `redactSource`, `redactUrl`, `redactProxy`, or
  `scrubCredentials` before it reaches `detail`.
- Scrubbing happens **before** truncation. A `slice` can cut a `//user:pass@` in half and leave
  nothing for the redactor to recognise.
- A header value that cannot be sent as an HTTP header is never sent and never quoted back.
- Over plain `http://` to another machine, a credential is withheld rather than sent, and the row
  says so.
- `curl` runs with `-q` first, so a `~/.curlrc` cannot inject options or a different proxy.
- A config file that cannot be parsed is described without quoting its contents.

## Supported versions

Fixes land on the latest published minor. Older versions are not patched; upgrade with
`npx pi-checkup@latest`.
