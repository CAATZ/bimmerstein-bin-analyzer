import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { pushToast } from '../store/actions.js';

export const appVersion = getVersion;

export async function openHelp(target: 'manual' | 'repository' | 'issues' | 'license'): Promise<void> {
  try {
    await invoke('open_help', { target });
  } catch (error) {
    pushToast('error', String(error));
  }
}
