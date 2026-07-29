import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // svelte-check + vite-plugin-svelte v5 require a Svelte config to enable
  // TS in <script lang="ts"> and to resolve .svelte modules for the checker.
  preprocess: vitePreprocess(),
};
