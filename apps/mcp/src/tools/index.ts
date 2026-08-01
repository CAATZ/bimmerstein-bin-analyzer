import type { ToolSpec } from '../result.js';
import { openBinTool } from './open-bin.js';
import { listBinsTool } from './list-bins.js';
import { scanBinTool } from './scan-bin.js';

export { openBinTool, listBinsTool, scanBinTool };

/** Registration order is the order an agent sees in tools/list. */
export const TOOLS: ToolSpec[] = [openBinTool, listBinsTool, scanBinTool];
