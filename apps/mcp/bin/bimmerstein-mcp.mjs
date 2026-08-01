#!/usr/bin/env node
// Launcher for the BimmerStein MCP server.
//
// The workspace ships raw TypeScript with .js import specifiers, which Node's
// native type-stripping cannot resolve (measured 2026-07-31), so a loader is
// mandatory. `node --import tsx <entry>` resolves the bare "tsx" specifier
// against the process CWD — and an MCP client picks its own CWD — so the
// loader is registered programmatically here instead.
//
// register() is PER-THREAD: a worker_threads Worker does not inherit it. The
// resolved loader URL is therefore handed to the TS entry through the
// environment, and WorkerScanner passes it to the scan worker as
// execArgv ['--import', <url>].
import { register } from 'tsx/esm/api';

register();
process.env.BINALYZER_TSX_LOADER = import.meta.resolve('tsx/esm');
await import('../src/main.ts');
