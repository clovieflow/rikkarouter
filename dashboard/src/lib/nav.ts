// App-level state: section registry per spec §08 + persisted dashboard prefs.
import { writable } from "svelte/store";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  shortcut?: string;
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Command",
    items: [{ id: "overview", label: "Overview", href: "#/", shortcut: "⌘1" }],
  },
  {
    section: "Routing",
    items: [
      { id: "routes", label: "Routes", href: "#/routes", shortcut: "⌘R" },
      { id: "playground", label: "Playground", href: "#/playground" },
      { id: "providers", label: "Providers", href: "#/providers" },
      { id: "models", label: "Models", href: "#/models" },
    ],
  },
  {
    section: "Observability",
    items: [
      { id: "requests", label: "Requests", href: "#/requests" },
      { id: "chats", label: "Chats", href: "#/chats" },
      { id: "analytics", label: "Analytics", href: "#/analytics" },
      { id: "logs", label: "Logs", href: "#/logs" },
      { id: "costs", label: "Costs", href: "#/costs" },
    ],
  },
  {
    section: "Control",
    items: [
      { id: "keys", label: "API Keys", href: "#/keys" },
      { id: "aliases", label: "Aliases", href: "#/aliases" },
      { id: "policies", label: "Policies", href: "#/policies" },
    ],
  },
  {
    section: "System",
    items: [
      { id: "proxies", label: "Proxies", href: "#/proxies" },
      { id: "settings", label: "Settings", href: "#/settings" },
      { id: "status", label: "Status", href: "#/status" },
      { id: "docs", label: "Docs", href: "#/docs" },
      { id: "changelog", label: "Changelog", href: "#/changelog" },
    ],
  },
];

export const route = writable<string>(location.hash.slice(1) || "/");
window.addEventListener("hashchange", () => route.set(location.hash.slice(1) || "/"));

export function go(href: string): void {
  location.hash = href;
}

// The key the dashboard itself uses against /v1 (stored locally, never synced).
const LS_KEY = "rikka.clikey";
export const clientKey = writable<string>(localStorage.getItem(LS_KEY) ?? "");
export function setClientKey(v: string): void {
  localStorage.setItem(LS_KEY, v);
  clientKey.set(v);
}
