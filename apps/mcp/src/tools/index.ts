import type { ToolSpec } from '../result.js';
import { openBinTool } from './open-bin.js';
import { listBinsTool } from './list-bins.js';

export { openBinTool, listBinsTool };

/** Registration order is the order an agent sees in tools/list. */
export const TOOLS: ToolSpec[] = [openBinTool, listBinsTool];
