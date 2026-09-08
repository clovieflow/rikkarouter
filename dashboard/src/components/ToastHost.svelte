<script lang="ts">
  import { toasts } from "../lib/toast.ts";
  import Toast from "./Toast.svelte";
  // ToastHost — mount ONCE near the app root. NOT YET MOUNTED (App.svelte is
  // owned by another agent). Install with these 3 lines:
  //   1. import ToastHost from "./components/ToastHost.svelte";
  //   2. place <ToastHost /> next to <CommandPalette> at the end of App.svelte
  //   3. call `toast("…", "ok" | "err" | "info")` from lib/toast.ts anywhere
</script>

<div class="host" aria-live="polite" aria-atomic="false">
  {#each $toasts as t (t.id)}
    <Toast item={t} />
  {/each}
</div>

<style>
  .host {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 200;
  }
  .host:empty {
    display: none;
  }
</style>
