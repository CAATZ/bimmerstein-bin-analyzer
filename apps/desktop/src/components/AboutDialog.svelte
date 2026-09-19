<script lang="ts">
  import { onMount } from 'svelte';
  import logo from '../../src-tauri/icons/bimmerstein-blue.svg';
  import { appVersion, openHelp } from '../platform/help.js';
  import { pushModal, popModal } from '../store/actions.js';

  let { onclose }: { onclose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let version = $state('');
  let message = $state('');
  const information = $derived(`BimmerStein Bin Analyzer ${version}\nWindows x64\nDeveloper: Cristian Ayon\nLicense: GPL-3.0-or-later\nhttps://github.com/CAATZ/bimmerstein-bin-analyzer`);

  onMount(() => {
    pushModal();
    dialog.showModal();
    void appVersion().then((value) => (version = value)).catch(() => (message = 'Version information is unavailable.'));
    return popModal;
  });

  async function copyVersion(): Promise<void> {
    try {
      await navigator.clipboard.writeText(information);
      message = 'Version information copied.';
    } catch {
      message = 'Could not copy. Select the version information below and copy it manually.';
    }
  }

  function keepFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
      event.preventDefault();
      (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="about-title" {onclose} onkeydown={keepFocus}>
  <header>
    <img src={logo} alt="BimmerStein" width="48" height="48" />
    <div><h2 id="about-title">BimmerStein Bin Analyzer</h2><p>ECU binary analysis and map editing</p></div>
  </header>
  <dl>
    <dt>Version</dt><dd>{version || 'Loading…'}</dd>
    <dt>Developer</dt><dd>Cristian Ayon</dd>
    <dt>Platform</dt><dd>Windows x64</dd>
    <dt>License</dt><dd>GPL-3.0-or-later</dd>
  </dl>
  <div class="links" aria-label="Project information">
    <button onclick={() => void openHelp('repository')}>Repository</button>
    <button onclick={() => void openHelp('issues')}>Report an issue</button>
    <button onclick={() => void openHelp('license')}>View license</button>
  </div>
  <p class="status" role="status">{message}</p>
  {#if message.startsWith('Could not copy')}<pre>{information}</pre>{/if}
  <footer>
    <button disabled={!version} onclick={() => void copyVersion()}>Copy version information</button>
    <button class="primary" onclick={() => dialog.close()}>Close</button>
  </footer>
</dialog>

<style>
  dialog { width: min(480px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; color: var(--fg); background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px #0008; }
  dialog::backdrop { background: #0008; }
  header { display: flex; align-items: center; gap: 14px; }
  h2 { font-size: 18px; margin: 0; }
  p { color: var(--fg-dim); font-size: 12px; margin: 6px 0 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 24px; margin: 24px 0; font-size: 13px; user-select: text; }
  dt { color: var(--fg-dim); } dd { margin: 0; }
  .links, footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .links button { background: transparent; font-size: 12px; }
  .status { display: block; border: 0; padding: 0; min-height: 18px; white-space: normal; margin: 14px 0; }
  footer { justify-content: space-between; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font-size: 12px; }
</style>
