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
- Value and breakpoint edits change a working buffer with undo/redo. Saving a
  BIN writes a separate output, applies supported checksum corrections and
  verifies the written bytes by reading them back. The original source path
  is protected against overwrite.
- Projects, definitions and map packs are written through the app's file
  dialogs. Loading a file does not authorize a firmware save or ECU operation;
  the app has no ECU communication or flashing interface.

Malformed inputs can cause incorrect analysis, rejected operations, hangs or
crashes. Incorrect definitions or edits can also produce unsuitable firmware
output; checksum verification does not establish tuning safety. Please report
violations of the parsing, rendering or save boundaries above.

## Family modules

Loadable JavaScript family modules are executable extensions, not data files.
They run in the desktop process without a sandbox and can affect identity,
checksum verification and correction. Load only trusted modules. Interface
checks and exception handling do not make an untrusted module safe.

## Companion server

`apps/mcp` is a stdio server that runs only when you start it, and is not
included in the installers.

Its `--copilot` mode listens on `127.0.0.1` on an OS-assigned port and writes
the port plus a per-start token to a handshake file in your local state
directory. Nothing listens when the server is not running. The desktop side is
gated by an explicit consent toggle that defaults to off and must be turned on
by the user.

The co-pilot connects the shared session to the user's configured AI client.
That client may send the data it reads to its provider; the loopback link is
not a guarantee that shared data stays on the computer.

Single map/axis definition changes can apply directly with undo. Bulk definition
changes and every value edit require review in the app. The server cannot save
a BIN. It can request the app's Save Project dialog, where the user chooses the
destination.

The server can write definition exports only with `--allow-write <dir>`;
the resolved real path must be inside that directory, with symlinks resolved
before the check. This option does not control the desktop's file dialogs or
the server's local connection handshake file.

## Unsigned builds

Released installers are **not code-signed** — there is no certificate for this
project yet. Windows SmartScreen may warn on first run. Verify the release
source, filename and published checksums before proceeding. Source build
instructions are in the README; byte-identical reproducible builds are not
currently verified.
