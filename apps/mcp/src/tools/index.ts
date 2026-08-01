import type { ToolSpec } from '../result.js';
import { openBinTool } from './open-bin.js';
import { listBinsTool } from './list-bins.js';
import { scanBinTool } from './scan-bin.js';
import { listMapsTool } from './list-maps.js';
import { getMapTool } from './get-map.js';
import { readMapTool } from './read-map.js';
import { readBytesTool } from './read-bytes.js';
import { listDetectedAxesTool } from './list-detected-axes.js';

export { openBinTool, listBinsTool, scanBinTool, listMapsTool, getMapTool, readMapTool, readBytesTool, listDetectedAxesTool };

/** Registration order is the order an agent sees in tools/list. */
export const TOOLS: ToolSpec[] = [
  openBinTool,
  listBinsTool,
  scanBinTool,
  listMapsTool,
  getMapTool,
  readMapTool,
  readBytesTool,
  listDetectedAxesTool,
];
