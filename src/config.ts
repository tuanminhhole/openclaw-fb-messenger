import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "fb-messenger";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_GRAPH_API_VERSION = "v24.0";
export const MESSENGER_TEXT_LIMIT = 2000;
/** MonkeyTech Connect: giu token Trang + App Secret, bot chi cam botKey (xem README muc Relay). */
export const DEFAULT_RELAY_URL = "https://connect.monkeytech.vn";

export type MessengerDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
/**
 * webhook: Meta goi thang vao gateway (can HTTPS public, token + App Secret o may nay).
 * relay:   gateway long-poll MonkeyTech Connect (bot sau NAT, khong token, khong App Secret).
 */
export type MessengerTransport = "webhook" | "relay";

/** Per-account config as stored under `channels.fb-messenger` in openclaw.json. */
export interface MessengerAccountConfig {
  name?: string;
  enabled?: boolean;
  pageId?: string;
  pageAccessToken?: string;
  appId?: string;
  appSecret?: string;
  verifyToken?: string;
  graphApiVersion?: string;
  dmPolicy?: MessengerDmPolicy;
  allowFrom?: string[];
  historyLimit?: number;
  messagePrefix?: string;
  responsePrefix?: string;
  transport?: MessengerTransport;
  relayUrl?: string;
  /** Reaction xac nhan da nhan tin: emoji, hoac ma Zalo "/-heart" (doi thanh ❤️); "" de tat. */
  ackReaction?: string;
  /** Instagram professional account gan voi Trang (relay mode: Connect bao ve). */
  instagramId?: string;
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
  appId: string;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
  dmPolicy: MessengerDmPolicy;
  allowFrom: string[];
  historyLimit: number;
  transport: MessengerTransport;
  relayUrl: string;
  instagramId: string;
  /** Emoji reaction da chuan hoa, "" neu tat. */
  ackReaction: string;
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
  const appId =
    pick(env.FB_MESSENGER_APP_ID, account.appId, channel.appId) ?? "";
  const appSecret =
    pick(env.FB_MESSENGER_APP_SECRET, account.appSecret, channel.appSecret) ?? "";
  const verifyToken =
    pick(env.FB_MESSENGER_VERIFY_TOKEN, account.verifyToken, channel.verifyToken) ?? "";
  const relayUrl = (pick(env.FB_MESSENGER_RELAY_URL, account.relayUrl, channel.relayUrl) ?? DEFAULT_RELAY_URL).replace(/\/+$/, "");
  // Mac dinh: co token Trang thi la webhook (ban 0.1 cu), khong co thi la relay.
  const explicit = pick(env.FB_MESSENGER_TRANSPORT as MessengerTransport | undefined, account.transport, channel.transport);
  const transport: MessengerTransport = explicit === "webhook" || explicit === "relay" ? explicit : pageAccessToken ? "webhook" : "relay";
  // Relay: accountId chinh la pageId (Setup UI ghi accounts[<pageId>]), tru khi khai pageId rieng.
  const pageId = pick(account.pageId, channel.pageId) ?? (transport === "relay" && accountId !== DEFAULT_ACCOUNT_ID ? accountId : "");

  // Uu tien khoa cua kenh/account, roi `messages.ackReaction` toan cuc cua OpenClaw (Setup dat "/-heart"
  // cho Zalo; o day doi sang emoji). Khai "" de tat han.
  const messagesCfg = (params.cfg as { messages?: { ackReaction?: string } }).messages;
  const rawAck = account.ackReaction ?? channel.ackReaction ?? messagesCfg?.ackReaction ?? "";

  return {
    accountId,
    name: pick(account.name, channel.name),
    enabled: account.enabled ?? channel.enabled ?? true,
    pageId,
    pageAccessToken,
    appId,
    appSecret,
    verifyToken,
    graphApiVersion:
      pick(account.graphApiVersion, channel.graphApiVersion) ?? DEFAULT_GRAPH_API_VERSION,
    dmPolicy: (pick(account.dmPolicy, channel.dmPolicy) ?? "open") as MessengerDmPolicy,
    allowFrom: account.allowFrom ?? channel.allowFrom ?? ["*"],
    historyLimit: account.historyLimit ?? channel.historyLimit ?? 50,
    transport,
    relayUrl,
    instagramId: pick(account.instagramId, channel.instagramId) ?? "",
    ackReaction: normalizeAckReaction(rawAck),
    config: { ...channel, ...account },
  };
}

/**
 * True if the account has the minimum credentials to operate.
 * webhook: Page token + verify token. relay: a pageId (the botKey lives in the credentials dir).
 */
export function isAccountConfigured(account: ResolvedMessengerAccount): boolean {
  if (account.transport === "relay") return Boolean(account.pageId);
  return Boolean(account.pageAccessToken && account.verifyToken);
}

const ZALO_REACTION_EMOJI: Record<string, string> = {
  "/-heart": "❤️", "/-strong": "👍", ":>": "😆", ":-((": "😢", ":o": "😮", ":-h": "😡", "/-remove": "",
};

/** "/-heart" (ma Zalo) -> ❤️; emoji giu nguyen; chuoi khac hoac rong -> "" (tat). */
export function normalizeAckReaction(value: unknown): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (v in ZALO_REACTION_EMOJI) return ZALO_REACTION_EMOJI[v] ?? "";
  // chi nhan emoji (ky tu ngoai ASCII), tranh gui chu thuong len Graph
  return /^[^\x00-\x7F]{1,8}$/u.test(v) ? v : "";
}

/** Allowlist check for DM senders (PSIDs). `*` allows everyone. */
export function isSenderAllowed(account: ResolvedMessengerAccount, senderId: string): boolean {
  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "open") return true;
  const allow = account.allowFrom.map((e) => e.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return allow.includes(senderId.trim());
}
