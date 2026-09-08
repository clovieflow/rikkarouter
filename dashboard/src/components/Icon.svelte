<script lang="ts">
  import { ICONS } from "../lib/icons.ts";
  let {
    name,
    size = 16,
    class: cls = "",
  }: { name: string; size?: number; class?: string } = $props();
</script>

<span class="icon {cls}" style="width:{size}px;height:{size}px" aria-hidden="true">
  {@html ICONS[name] ?? ""}
</span>

<style>
  .icon {
    display: inline-flex;
    flex-shrink: 0;
  }
  .icon :global(svg) {
    width: 100%;
    height: 100%;
  }
</style>
