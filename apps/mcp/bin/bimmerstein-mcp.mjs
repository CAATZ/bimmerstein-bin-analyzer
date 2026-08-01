#!/usr/bin/env node
// Launcher for the BimmerStein MCP server.
//
// The workspace ships raw TypeScript with .js import specifiers, which Node's
// native type-stripping cannot resolve (measured 2026-07-31), so a loader is
// mandatory. `node --import tsx <entry>` resolves the bare "tsx" specifier
// against the process CWD — and an MCP client picks its own CWD — so the
// loader is registered programmatically here instead.
//
// register() is PER-THREAD: a worker_threads Worker does not inherit it, so
// the scan worker bootstraps its own loader the same way (see
// src/scan-worker-boot.mjs) rather than being handed this one.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
