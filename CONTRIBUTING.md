# Contributing

Thanks for looking. This is a small, dependency-free package, so the whole loop is short.

## Setup

Nothing to install beyond Node 20 or newer:

```bash
git clone https://github.com/xinghe-labs/pi-checkup.git
cd pi-checkup
node --test          # the whole suite, ~2s
npm run lint         # node --check on every source file
```

There are no runtime dependencies and there is no build step. `npm install` is not required to run
the tests; it is only needed if you want `npx biome` locally.

## The one rule that matters

**A check must not claim more than it inspected.**

This is the reason the package exists. `pi list` and a shell script both report things they did not
verify; the whole point here is to say `skip` when nothing was looked at, `warn` when something is
unproven, and `fail` only for confirmed breakage. A green tick over zero inspected objects is a bug,
not a cosmetic issue.

That rule shows up in review as:

- `skip` when the input was absent, empty, or unreadable-but-not-broken.
- `warn` when the check could not establish the answer — a timeout, a permission error, a registry
  that failed to load.
- `fail` only when the thing was asked and answered "no" — a refused connection, an HTTP error, a
  file that does not parse, a directory that is genuinely gone.

If you are unsure which one applies, the answer is usually `warn` plus a sentence that says what
was and was not established.

## Adding a check

1. Put it in the module that owns the group (`src/checks/<group>.js`), or add a module and register
   it in `src/checks/index.js`.
2. Build rows with the module's `row()` helper so every row carries `group`, `id`, `title`,
   `status`, and `detail`. `id` is what `PI_CHECKUP_IGNORE` matches, so it has to be stable and
   unique within the group.
3. Return a **skipped** row rather than no row when there is nothing to inspect. A missing row reads
   as "fine" to anyone counting rows.
4. Anything that comes from a third-party file (`package.json`, `settings.json`, `models.json`) is
   untrusted text on its way to a terminal and to `--json`. Route it through `redactSource`,
   `redactUrl`, or `scrubCredentials` before it reaches `detail`.
5. Scrub **before** truncating, never after. A slice can cut a `//user:pass@` in half and leave
   nothing for the redactor to recognise.
6. Add a test in `test/checks.test.js` for the wrong answer you are preventing, not just the happy
   path. The test name should describe the defect, e.g. `"a refused connection is a failure, not a
   warning"`.

## Changing a repair

`src/repair.js` is the only module that writes to disk. Anything you add there must:

- back the file up **before** writing, and use `backupFor` so one run writes one backup per file;
- write through `writeAtomic`, which verifies the byte count before renaming;
- refuse rather than guess when the state it needs is not the state it found (see the guard in
  `applyPruneMissingPackages` that refuses to empty the list);
- be reversible by hand from the files left on disk.

## README captures

The `text` blocks in `README.md` are real output, not mock-ups, and they are compared byte for byte.
If a change alters the report, re-run it and paste the new output rather than editing the block by
hand:

```bash
npx pi-checkup                       # the CLI block
# and inside a session: /checkup     # the 24-row block
```

Code blocks stay at or under 80 columns.

## Commits

Conventional-commit prefixes are used loosely: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`. The
subject is a full sentence describing the behaviour that changed, not the file that changed —
`fix: a directory named bin/pi is not a launcher` rather than `fix: runtime.js`.

If a change fixes a defect, say in the body what the wrong behaviour was and what input triggers it.
That sentence is what makes the commit worth reading in a year.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
