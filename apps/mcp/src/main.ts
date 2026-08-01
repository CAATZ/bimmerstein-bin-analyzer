import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgv } from './argv.js';
import { NodeFileIo } from './fsio.js';
import { MemorySessionStore } from './session.js';
import { WorkerScanner } from './scanner.js';
import { createMcpServer } from './server.js';
import type { Deps } from './result.js';

const parsed = parseArgv(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
}

const scanner = new WorkerScanner();
const deps: Deps = {
  store: new MemorySessionStore(),
  scanner,
  io: new NodeFileIo(),
  ...(parsed.value.writeRoot !== undefined ? { writeRoot: parsed.value.writeRoot } : {}),
};

const server = createMcpServer(deps);
const transport = new StdioServerTransport();

let shuttingDown = false;
const shutdown = (code: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void scanner.dispose().finally(() => process.exit(code));
};
transport.onclose = (): void => shutdown(0);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

await server.connect(transport);
// stdout belongs to the protocol — every diagnostic goes to stderr.
const grant = parsed.value.writeRoot !== undefined ? ` (writes allowed under ${parsed.value.writeRoot})` : '';
process.stderr.write(`bimmerstein-mcp ready${grant}\n`);
