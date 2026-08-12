import { describe, expect, it } from 'vitest';
import { COPILOT_TOOLS, HEADLESS_TOOLS } from '../src/tools/index.js';
import { COPILOT_INSTRUCTIONS } from '../src/server.js';

describe('no tool can write a bin', () => {
  it('neither registry offers a bin-writing tool', () => {
    for (const registry of [COPILOT_TOOLS, HEADLESS_TOOLS]) {
      expect(registry.filter((t) => /save_bin|write_bin/.test(t.name))).toEqual([]);
    }
  });

  it('the only save tool is save_project', () => {
    // save_project runs the app's own project-save flow and writes a JSON
    // definition file — never an image.
    const saves = COPILOT_TOOLS.filter((t) => t.name.includes('save')).map((t) => t.name);
    expect(saves).toEqual(['save_project']);
  });

  it('the instructions say so positively, so the agent asks instead of hunting', () => {
    expect(COPILOT_INSTRUCTIONS).toMatch(/cannot save|only the user can save/i);
  });
});
