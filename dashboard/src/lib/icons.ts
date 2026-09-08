// Thin geometric line icons, lucide-flavored, hand-tuned to one family (spec §44).
// 24×24 viewBox, stroke=currentColor, stroke-width 1.5, no fill.

const S = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICONS: Record<string, string> = {
  overview: S('<path d="M4 13a8 8 0 1 1 16 0"/><path d="M12 13l3.5-3.5"/><path d="M4 13v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
  routes: S('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V13a3 3 0 0 0 3 3h6.5"/><path d="M15 13.5l3 2.5-3 2.5" transform="rotate(180 16.5 16)"/>'),
  providers: S('<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3"/>'),
  models: S('<path d="M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9L12 3z"/><path d="M12 8.2l3 1.9v3.8l-3 1.9-3-1.9v-3.8l3-1.9z"/>'),
  requests: S('<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>'),
  analytics: S('<path d="M4 4v16h16"/><path d="M8 14.5l3.5-4 3 2.5L20 7"/>'),
  logs: S('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12.5h8M8 16h5"/>'),
  costs: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M14.8 9.4c-.7-1-1.7-1.4-2.8-1.4-1.6 0-2.9 1-2.9 2.3 0 2.9 5.8 1.6 5.8 4.4 0 1.3-1.3 2.3-2.9 2.3-1.2 0-2.2-.5-2.8-1.4"/>'),
  keys: S('<circle cx="8" cy="14" r="4"/><path d="M11 12l8-8M16.5 6.5l2 2M14 9l2 2"/>'),
  aliases: S('<path d="M4 7h6v10H4z" opacity="0"/><path d="M4 8.5h7M4 12h7M4 15.5h4"/><path d="M14.5 6l4 6-4 6"/>'),
  policies: S('<path d="M12 3.5l7 2.5v5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5v-5l7-2.5z"/><path d="M9.2 12l2 2 3.6-4"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>'),
  status: S('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16.5 9"/>'),
  changelog: S('<path d="M6 4h9l3.5 3.5V20H6z"/><path d="M9.5 11h5M9.5 14.5h5M9.5 7.5h2"/>'),
  search: S('<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>'),
  bell: S('<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z"/><path d="M10 18.5a2.2 2.2 0 0 0 4 0"/>'),
  command: S('<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  trash: S('<path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 12.5h9L18 7M10 10.5v6M14 10.5v6"/>'),
  copy: S('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>'),
  check: S('<path d="M4.5 12.5l5 5L19.5 7"/>'),
  x: S('<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>'),
  refresh: S('<path d="M20 11a8 8 0 1 0-1.5 6M20 5.5V11h-5.5"/>'),
  bolt: S('<path d="M13 2.5L5 13.5h6L11 21.5l8-11h-6l0-8z"/>'),
  back: S('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
};
