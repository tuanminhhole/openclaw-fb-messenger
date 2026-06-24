import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "fb-messenger";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_GRAPH_API_VERSION = "v21.0";
export const MESSENGER_TEXT_LIMIT = 2000;

export type MessengerDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

/** Per-account config as stored under `channels.fb-messenger` in openclaw.json. */
export interface MessengerAccountConfig {
  name?: string;
  enabled?: boolean;
  pageId?: string;
  pageAccessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  graphApiVersion?: string;
  dmPolicy?: MessengerDmPolicy;
  allowFrom?: string[];
  historyLimit?: number;
  messagePrefix?: string;
  responsePrefix?: string;
}

export interface MessengerChannelConfig extends MessengerAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, MessengerAccountConfig>;
}

/** Fully-resolved account with secrets layered in from the environment. */
export interface ResolvedMessengerAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  pageId: string;
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
  dmPolicy: MessengerDmPolicy;
  allowFrom: string[];
  historyLimit: number;
  config: MessengerAccountConfig;
}

function readChannelConfig(cfg: OpenClawConfig): MessengerChannelConfig {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
  return (channels[CHANNEL_ID] as MessengerChannelConfig | undefined) ?? {};
}

export function normalizeAccountId(accountId?: string | null): string {
  const trimmed = (accountId ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

export function listMessengerAccountIds(cfg: OpenClawConfig): string[] {
  const channel = readChannelConfig(cfg);
  const ids = Object.keys(channel.accounts ?? {});
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

function pick<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined && v !== "") return v;
  return undefined;
}

/**
 * Resolve a single account, merging (in priority order) env vars → account
 * override → channel top-level → defaults. Env wins so secrets never need to
 * live in openclaw.json.
 */
export function resolveMessengerAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedMessengerAccount {
  const env = params.env ?? process.env;
  const channel = readChannelConfig(params.cfg);
  const accountId = normalizeAccountId(
    params.accountId ?? channel.defaultAccount ?? DEFAULT_ACCOUNT_ID,
  );
  const account = channel.accounts?.[accountId] ?? {};

  const pageAccessToken =
    pick(env.FB_MESSENGER_PAGE_ACCESS_TOKEN, account.pageAccessToken, channel.pageAccessToken) ?? "";
  const appSecret =
    pick(env.FB_MESSENGER_APP_SECRET, account.appSecret, channel.appSecret) ?? "";
  const verifyToken =
    pick(env.FB_MESSENGER_VERIFY_TOKEN, account.verifyToken, channel.verifyToken) ?? "";

  return {
    accountId,
    name: pick(account.name, channel.name),
    enabled: account.enabled ?? channel.enabled ?? true,
    pageId: pick(account.pageId, channel.pageId) ?? "",
    pageAccessToken,
    appSecret,
    verifyToken,
    graphApiVersion:
      pick(account.graphApiVersion, channel.graphApiVersion) ?? DEFAULT_GRAPH_API_VERSION,
    dmPolicy: (pick(account.dmPolicy, channel.dmPolicy) ?? "open") as MessengerDmPolicy,
    allowFrom: account.allowFrom ?? channel.allowFrom ?? ["*"],
    historyLimit: account.historyLimit ?? channel.historyLimit ?? 50,
    config: { ...channel, ...account },
  };
}

/** True if the account has the minimum credentials to operate. */
export function isAccountConfigured(account: ResolvedMessengerAccount): boolean {
  return Boolean(account.pageAccessToken && account.verifyToken);
}

/** Allowlist check for DM senders (PSIDs). `*` allows everyone. */
export function isSenderAllowed(account: ResolvedMessengerAccount, senderId: string): boolean {
  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "open") return true;
  const allow = account.allowFrom.map((e) => e.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return allow.includes(senderId.trim());
}
