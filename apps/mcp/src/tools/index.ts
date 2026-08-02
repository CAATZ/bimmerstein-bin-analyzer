import type { ToolSpec } from '../result.js';
import { openBinTool } from './open-bin.js';
import { listBinsTool } from './list-bins.js';
import { scanBinTool } from './scan-bin.js';
import { listMapsTool } from './list-maps.js';
import { getMapTool } from './get-map.js';
import { readMapTool } from './read-map.js';
import { readBytesTool } from './read-bytes.js';
import { listDetectedAxesTool } from './list-detected-axes.js';
import { importDefinitionTool } from './import-definition.js';
import { exportDefinitionTool } from './export-definition.js';
import { getSessionTool } from './get-session.js';
import { openMapTool, selectTool, showTool } from './point.js';
import { changeAxisEntryTool, changeMapTool } from './change.js';

export {
  openBinTool,
  listBinsTool,
  scanBinTool,
  listMapsTool,
  getMapTool,
  readMapTool,
  readBytesTool,
  listDetectedAxesTool,
  importDefinitionTool,
  exportDefinitionTool,
  getSessionTool,
  selectTool,
  showTool,
  openMapTool,
  changeMapTool,
  changeAxisEntryTool,
};

/** Registration order is the order an agent sees in tools/list. */
export const HEADLESS_TOOLS: ToolSpec[] = [
  openBinTool,
  listBinsTool,
  scanBinTool,
  listMapsTool,
  getMapTool,
  readMapTool,
  readBytesTool,
  listDetectedAxesTool,
  importDefinitionTool,
  exportDefinitionTool,
];

/**
 * Co-pilot mode (2026-08-01-mcp-copilot-design.md §8). open_bin and list_bins
 * are withheld — the user opens bins — and load_project is not shipped in
 * either mode (P7). Session-aware tools are appended here as they land.
 */
export const COPILOT_TOOLS: ToolSpec[] = [
  getSessionTool,
  selectTool,
  showTool,
  openMapTool,
  changeMapTool,
  changeAxisEntryTool,
  scanBinTool,
  listMapsTool,
  getMapTool,
  readMapTool,
  readBytesTool,
  listDetectedAxesTool,
  importDefinitionTool,
  exportDefinitionTool,
];

/** @deprecated Headless registry under its Phase-1 name; prefer HEADLESS_TOOLS. */
export const TOOLS = HEADLESS_TOOLS;
