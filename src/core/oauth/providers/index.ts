// Provider registry — 19 flows (7 original + 12 ported). Providers requiring MITM
// (cursor, windsurf, trae) are intentionally NOT here — they need IDE sniffing.
import type { OAuthProviderDef } from "../types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { geminiCli } from "./gemini-cli.ts";
import { github } from "./github.ts";
import { iflow } from "./iflow.ts";
import { kimi } from "./kimi.ts";
import { xai } from "./xai.ts";
import { gitlab } from "./gitlab.ts";
import { grokCli } from "./grok-cli.ts";
import { kilocode } from "./kilocode.ts";
import { cline } from "./cline.ts";
import { clinepass } from "./clinepass.ts";
import { kimchi } from "./kimchi.ts";
import { antigravity } from "./antigravity.ts";
import { codebuddyCn } from "./codebuddy-cn.ts";
import { codebuddyIntl } from "./codebuddy-intl.ts";
import { qoder } from "./qoder.ts";
import { zed } from "./zed.ts";
import { kiro } from "./kiro.ts";

export { claude, codex, geminiCli, github, iflow, kimi, xai, gitlab, grokCli, kilocode, cline, clinepass, kimchi, antigravity, codebuddyCn, codebuddyIntl, qoder, zed, kiro };

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  claude,
  codex,
  "gemini-cli": geminiCli,
  github,
  xai,
  kimi,
  iflow,
  gitlab,
  "grok-cli": grokCli,
  kilocode,
  cline,
  clinepass,
  kimchi,
  antigravity,
  "codebuddy-cn": codebuddyCn,
  "codebuddy-intl": codebuddyIntl,
  qoder,
  zed,
  kiro,
};
