<script lang="ts">
  // Toggle (§46): switch control. Controlled via bind:checked.
  let {
    checked = $bindable(false),
    label,
    onchange,
  }: {
    checked?: boolean;
    label: string;
    onchange?: (v: boolean) => void;
  } = $props();

  function flip(): void {
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button class="tgl" class:on={checked} role="switch" aria-checked={checked} aria-label={label} onclick={flip}>
  <span class="track" aria-hidden="true"><span class="knob"></span></span>
  <span class="tlab">{label}</span>
</button>

<style>
  .tgl {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    padding: 2px;
    cursor: pointer;
    font-family: inherit;
  }
  .track {
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge-strong);
    display: inline-flex;
    align-items: center;
    padding: 0 2px;
    transition: background var(--dur-micro) var(--ease-out), border-color var(--dur-micro) var(--ease-out);
    flex-shrink: 0;
  }
  .knob {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--color-ink-faint);
    transition: transform var(--dur-micro) var(--ease-out), background var(--dur-micro) var(--ease-out);
  }
  .tgl.on .track {
    background: rgba(255, 22, 140, 0.16);
    border-color: rgba(255, 22, 140, 0.5);
  }
  .tgl.on .knob {
    transform: translateX(12px);
    background: var(--color-pink);
  }
  .tlab {
    font-size: 12px;
    color: var(--color-ink-muted);
  }
  .tgl:hover .tlab {
    color: var(--color-ink);
  }
</style>
