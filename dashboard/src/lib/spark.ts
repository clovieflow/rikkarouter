// Canonical sparkline path builder (min-max normalized, fixed viewport).
// NOTE: KpiCard.svelte and PolicyBudget.svelte still carry their own local
// sparkPath copies — migrating them is a one-line import change each, but
// both files are outside the current change scope, so the migration is left
// for their owner.
export function sparkPath(values: number[], width = 96, height = 26): string {
  const clean = values.filter((x) => Number.isFinite(x));
  if (clean.length < 2) return "";
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  return clean
    .map(
      (x, i) =>
        `${i ? "L" : "M"}${((i / (clean.length - 1)) * width).toFixed(1)} ${(
          height -
          2 -
          ((x - min) / span) * (height - 4)
        ).toFixed(1)}`,
    )
    .join(" ");
}
