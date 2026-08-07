# Security policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/CAATZ/bimmerstein-bin-analyzer/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and the file or input that triggered it.
Please do not attach ECU firmware — a description and the relevant offsets are
enough.

This is a small project maintained in spare time; expect a first response
within a couple of weeks rather than a couple of hours.

## Supported versions

Only the latest release receives fixes. The project is pre-1.0 and under active
development.

## Threat model

The application opens **untrusted binary files** — ECU firmware dumps from
unknown provenance — and third-party **definition XML**. Both are treated
strictly as data:

- Firmware bytes are decoded into numbers and rendered as text tables, a
  hexdump, or a WebGL surface. They never reach the DOM as markup.
- Text originating in an imported definition (map names, categories, units) is
  rendered through the UI framework's escaping, never as HTML.
- The application is **read-only with respect to firmware**: it never writes to
  a bin. The only files it writes are project files and definition exports, and
  only to a path the user picked in a save dialog.

Realistic impact of a malformed input is therefore a crash, a hang, or a wrong
analysis result — not code execution. Reports demonstrating otherwise are
exactly what this policy is for.

## Companion server

`apps/mcp` is a stdio server that runs only when you start it, and is not
included in the installers.

Its `--copilot` mode listens on `127.0.0.1` on an OS-assigned port and writes
the port plus a per-start token to a handshake file in your local state
directory. Nothing listens when the server is not running. The desktop side is
gated by an explicit consent toggle that defaults to off and must be turned on
by the user.

Writing files is refused unless the server was started with
`--allow-write <dir>`, and the resolved real path must be inside that directory
(symlinks are resolved before the check).

## Unsigned builds

Released installers are **not code-signed** — there is no certificate for this
project yet. Windows SmartScreen will warn on first run. If you would rather not
trust an unsigned binary, build from source; the README documents how, and the
build is reproducible from this repository.
