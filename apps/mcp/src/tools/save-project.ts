import { err, ok, requireLink, type ToolSpec } from '../result.js';

/**
 * The server NEVER writes the project file (P7). It asks the app to run its own
 * Save flow, dialog and all, so there is no new file-writing path here and no
 * interaction with the --allow-write guard.
 */
export const saveProjectTool: ToolSpec = {
  name: 'save_project',
  description:
    "Ask the app to save the user's project. It runs its own Save flow, including the file dialog, so the user chooses where it goes. Returns a requestId immediately; poll get_request.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handle(_raw, deps) {
    const link = requireLink(deps);
    if (!link.ok) return err(link.error);
    const table = deps.requests;
    if (table === undefined) return err('this server has no request table — it was not started in co-pilot mode');

    const row = table.create('save');
    const sent = await link.value.request('save_project', { requestId: row.requestId });
    if (!sent.ok) {
      table.settle(row.requestId, { status: 'cancelled', reason: sent.error });
      return err(sent.error);
    }
    return ok({ requestId: row.requestId, status: row.status });
  },
};
