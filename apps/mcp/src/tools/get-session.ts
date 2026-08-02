import { isMs41FullRead } from '@binanalyzer/appkit';
import { err, ok, requireLink, type ToolSpec } from '../result.js';

export const getSessionTool: ToolSpec = {
  name: 'get_session',
  description:
    "What the user currently has open in the app: the bin, how many maps they have confirmed, the axis library size, the address frame, their selection, their view, and the app's scan status. Call this first in co-pilot mode. It also reports whether YOUR OWN scan has run — that is independent of theirs.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handle(_raw, deps) {
    const link = requireLink(deps);
    if (!link.ok) return err(link.error);
    const state = link.value.state();
    if (state === null) return err('the app is connected but has not sent its session yet — retry in a moment');

    if (state.bin === null) {
      return ok({
        connected: true,
        bin: null,
        addressFrame: state.addressFrame,
        scanStatus: state.scanStatus,
      });
    }

    const entry = await deps.store.get(state.bin.sha256);
    return ok({
      connected: true,
      binId: state.bin.sha256,
      bin: {
        sha256: state.bin.sha256,
        name: state.bin.name,
        size: state.bin.size,
        isFullRead: isMs41FullRead(state.bin.size),
        hasPath: state.bin.path !== null,
      },
      confirmedMaps: state.maps.length,
      axisLibraryEntries: state.axisLibrary.length,
      addressFrame: state.addressFrame,
      selection: state.selection,
      view: {
        viewMode: state.viewParams.viewMode,
        columns: state.viewParams.columns,
        origin: state.viewParams.origin,
        format: state.viewParams.format,
      },
      scanStatus: state.scanStatus,
      coPilotScan:
        entry?.scan === undefined
          ? { scanned: false }
          : { scanned: true, potentialMaps: entry.scan.result.potentialMaps.length },
    });
  },
};
