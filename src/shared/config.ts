import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = process.env.RIKKA_DATA_DIR ?? path.join(os.homedir(), ".rikka");
mkdirSync(DATA_DIR, { recursive: true });

export const PORT = Number(process.env.PORT ?? 20200);
export const HOST = process.env.HOST ?? "127.0.0.1";
export { DATA_DIR };

export function dbFile(): string {
  return process.env.RIKKA_DB ?? path.join(DATA_DIR, "rikka.db");
}
