import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgv } from './argv.js';
import { NodeFileIo } from './fsio.js';
import { MemorySessionStore, type SessionStore } from './session.js';
import { LiveSessionStore } from './live-session.js';
import { WsCoPilotLink } from './link/server.js';
import { RequestTable } from './requests.js';
import { WorkerScanner } from './scanner.js';
import { createMcpServer } from './server.js';
import type { Deps } from './result.js';

const parsed = parseArgv(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
}

const scanner = new WorkerScanner();
const io = new NodeFileIo();

let link: WsCoPilotLink | undefined;
let requests: RequestTable | undefined;
let store: SessionStore;

if (parsed.value.copilot) {
  link = await WsCoPilotLink.listen();
  requests = new RequestTable();
  const table = requests;
  // A dropped link means nothing pending can ever be answered by the person
  // who was looking at that window.
  link.onDisconnect(() => table.cancelAll('the co-pilot link disconnected'));
  link.onDecision((id, accepted, rejected, failed) =>
    table.settle(id, {
      status: accepted.length > 0 ? 'accepted' : 'rejected',
      acceptedIds: accepted,
      rejectedIds: rejected,
      // A row the user accepted that then failed to apply is in NEITHER list;
      // without this the agent cannot tell a stale row from a vanished one.
      ...(failed.length > 0 ? { failed } : {}),
    })
  );
  store = new LiveSessionStore(link, io);
} else {
  store = new MemorySessionStore();
}

const deps: Deps = {
  store,
  scanner,
  io,
  ...(parsed.value.writeRoot !== undefined ? { writeRoot: parsed.value.writeRoot } : {}),
  ...(link !== undefined ? { link } : {}),
  ...(requests !== undefined ? { requests } : {}),
};

const server = createMcpServer(deps, parsed.value.copilot ? 'copilot' : 'headless');
const transport = new StdioServerTransport();

let shuttingDown = false;
const shutdown = (code: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled([scanner.dispose(), link?.close()]).finally(() => process.exit(code));
};
transport.onclose = (): void => shutdown(0);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

await server.connect(transport);
// stdout belongs to the protocol — every diagnostic goes to stderr.
const grant = parsed.value.writeRoot !== undefined ? ` (writes allowed under ${parsed.value.writeRoot})` : '';
process.stderr.write(`bimmerstein-mcp ready${grant}\n`);
