# BimmerStein Bin Analyzer — MCP server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes the BimmerStein detection engine to an agent: open an ECU `.bin`, scan
it, enumerate and decode maps and axes, import a RomRaider definition, export
definitions — with the desktop app not running.

**Read-only.** This server never modifies a bin. The only thing it can write is
a definition export, and only when started with `--allow-write <dir>`.

## Prerequisites

The repo's own: Node ≥ 22 and `pnpm install` once at the repo root. There is no
build step — the server runs from source under `tsx`.

## Launch

```json
{
  "mcpServers": {
    "bimmerstein": {
      "command": "node",
      "args": ["/absolute/path/to/bin-analyzer/apps/mcp/bin/bimmerstein-mcp.mjs"]
    }
  }
}
```

Add `"--allow-write", "/absolute/path/to/an/output/dir"` to `args` to let
`export_definition` write files there (and nowhere else — symlinks are
resolved before the check).

The launcher works from any working directory. It is not published to a
registry: the workspace packages are private and depend on each other with
`workspace:*`, so `npx` is not an option and the Tauri installer contains no
Node runtime.

## Tools

| Tool | What it does |
|---|---|
| `open_bin` | Read a `.bin` into the session; returns `binId` (its sha256) |
| `list_bins` | Bins currently resident (bounded LRU, most-recent first) |
| `scan_bin` | Run detection; returns a **summary only** (a 256 KB MS41 full read emits ~4,600 maps) |
| `list_maps` | Paginated, filtered rows over detected and/or imported maps |
| `get_map` | One map in full, with decoded axes |
| `read_map` | Decode values — by `mapId`, or an **ad-hoc** definition at any address |
| `read_bytes` | Bounded hex / decoded window |
| `list_detected_axes` | Count-prefixed axis runs (the shared MS4x axis pool) |
| `import_definition` | RomRaider XML → maps, storageaddress-framed on full reads |
| `export_definition` | RomRaider / XDF / CSV / JSON |

Addresses are **file offsets** everywhere except fields explicitly named
`storageAddress`.

## Safety

Bin bytes and imported definition text — including map names — are untrusted
data read from a file, never instructions.

## Co-pilot mode (`--copilot`)

Attach to a **running** BimmerStein Bin Analyzer window instead of opening bins
yourself:

```sh
node apps/mcp/bin/bimmerstein-mcp.mjs --copilot
```

The user must tick **Share session with co-pilot** in the app; that toggle is
the consent gate and is off by default. The server listens on `127.0.0.1` on an
OS-assigned port and publishes the port and a per-start token in a handshake
file under the user's local state directory; the app dials out and retries.
**Nothing is listening when this server is not running.**

The tool surface differs by mode and `tools/list` says so:

| | Headless | Co-pilot |
|---|---|---|
| `read_map`, `read_bytes`, `get_map`, `list_detected_axes`, `export_definition`, `scan_bin` | yes | yes, unchanged |
| `list_maps` | `source: potential \| imported \| all` | `source: potential \| confirmed \| all` |
| `open_bin`, `list_bins` | yes | **no** — the user opens bins |
| `get_session`, `select`, `show`, `open_map` | no | yes |
| `change_map`, `change_axis_entry` | no | yes — **one** target each |
| `propose_changes`, `get_request`, `save_project` | no | yes |
| `load_project` | no | no |

The co-pilot runs its **own** scan over the same bytes rather than reading the
app's: the engine is deterministic, so it gets byte-identical maps with the same
ids without touching the user's window. Bytes come from the app's file path when
their sha256 matches what the app reported, and over the link otherwise.

Changing **one** map or axis-library entry applies directly and is covered by
the app's undo. Anything touching **more than one** — including every
`import_definition` — goes to a review panel where the user accepts all, some or
none. Those calls return a `requestId` immediately and are polled with
`get_request`, so no tool call ever blocks on a person. `save_project` asks the
app to run its own Save; this server never writes a project file.
