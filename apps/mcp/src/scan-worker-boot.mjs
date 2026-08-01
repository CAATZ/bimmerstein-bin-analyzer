// Worker bootstrap. Plain JavaScript on purpose: it runs as the worker
// thread's entry, BEFORE any TypeScript loader exists in that thread.
//
// register() is PER-THREAD, so a Worker never inherits the parent's loader.
// The obvious alternative — handing the parent's resolved loader down via
// `execArgv: ['--import', <url>]` — is NOT portable: a Worker's execArgv
// accepts only a subset of node options, and which options take effect varies
// by Node version (measured 2026-08-01: worked on Node 24, silently failed to
// apply on the Node 22 CI runner, so the worker could not resolve the
// engine's `./config.js` specifiers). Registering inside the worker itself
// depends on nothing version-specific.
import { register } from 'tsx/esm/api';

register();
await import('./scan-worker.ts');
