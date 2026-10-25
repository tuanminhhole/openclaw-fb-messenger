import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  CHANNEL_ID,
  isAccountConfigured,
  listMessengerAccountIds,
  resolveMessengerAccount,
  normalizeAccountId,
  type MessengerAccountConfig,
  type ResolvedMessengerAccount,
} from "./config.js";
import { chunkMessengerText, resolvePermanentPageContext, subscribePageToApp, validateToken } from "./graph-api.js";
import { loadPageCredential, savePageCredential, clearPageCredential, loadRelayCredential } from "./credentials.js";
import { getDispatchContextForAccount, registerDispatchContext, type MessengerDispatchContext } from "./registry.js";
import { acquireRelayLoop } from "./relay.js";
import { createGraphSender, createRelaySender, type MessengerPlatform, type MessengerSender, type SendResult } from "./sender.js";
import { describeSendError, guessMediaType } from "./inbound.js";
import type { ChannelReplyDispatchSurface } from "./types.js";

const messengerMeta = {
  id: CHANNEL_ID,
  label: "Facebook Messenger",
  selectionLabel: "Facebook (Messenger)",
  docsPath: "/channels/fb-messenger",
  docsLabel: "fb-messenger",
  blurb: "Facebook Page Messenger + Instagram via MonkeyTech Connect relay or direct webhook.",
  aliases: ["fb", "messenger"],
  order: 90,
  quickstartAllowFrom: false,
};

const messengerCapabilities = {
  chatTypes: ["direct"],
  media: true,
  reactions: false,
  threads: false,
  polls: false,
  nativeCommands: false,
  blockStreaming: true,
};

// ── config adapter (hybrid: default account at root, named under `accounts`) ──
const messengerConfigAdapter = createHybridChannelConfigAdapter<ResolvedMessengerAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: (cfg) => listMessengerAccountIds(cfg as OpenClawConfig),
  resolveAccount: (cfg, accountId) =>
    resolveMessengerAccount({ cfg: cfg as OpenClawConfig, accountId }),
  defaultAccountId: (cfg) => {
    const channels = (cfg as { channels?: Record<string, { defaultAccount?: string }> }).channels;
    return normalizeAccountId(channels?.[CHANNEL_ID]?.defaultAccount);
  },
  clearBaseFields: [
    "name",
    "pageId",
    "pageAccessToken",
    "appId",
    "appSecret",
    "verifyToken",
    "graphApiVersion",
    "dmPolicy",
    "allowFrom",
    "historyLimit",
    "messagePrefix",
    "responsePrefix",
    "transport",
    "relayUrl",
    "instagramId",
    "ackReaction",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom),
});

// ── DM security policy resolver ───────────────────────────────────────────────
const messengerDmResolver = createScopedDmSecurityResolver<ResolvedMessengerAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
});

// ── setup adapter: write account credentials into openclaw.json ───────────────
const messengerSetupAdapter = {
  applyAccountConfig: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Record<string, unknown>;
  }): OpenClawConfig => {
    const cfg = params.cfg as OpenClawConfig & { channels?: Record<string, MessengerAccountConfig> };
    const channels = { ...(cfg.channels ?? {}) };
    const existing = (channels[CHANNEL_ID] as MessengerAccountConfig | undefined) ?? {};
    const input = params.input as Partial<MessengerAccountConfig>;
    channels[CHANNEL_ID] = {
      ...existing,
      enabled: true,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.pageAccessToken ? { pageAccessToken: input.pageAccessToken } : {}),
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.appSecret ? { appSecret: input.appSecret } : {}),
      ...(input.verifyToken ? { verifyToken: input.verifyToken } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
      ...(input.relayUrl ? { relayUrl: input.relayUrl } : {}),
      ...(input.instagramId ? { instagramId: input.instagramId } : {}),
      ...(typeof input.ackReaction === "string" ? { ackReaction: input.ackReaction } : {}),
      dmPolicy: existing.dmPolicy ?? "open",
      allowFrom: existing.allowFrom ?? ["*"],
    };
    return { ...cfg, channels } as OpenClawConfig;
  },
};

// ── gateway: register dispatch context per account, keep alive until aborted ──
const messengerGateway = {
  startAccount: async (ctx: {
    cfg: OpenClawConfig;
    accountId: string;
    abortSignal: AbortSignal;
    channelRuntime?: unknown;
    log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
    setStatus?: (s: unknown) => void;
  }): Promise<void> => {
    const account = resolveMessengerAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
    if (!account.enabled) return;
    if (!isAccountConfigured(account)) {
      ctx.log?.warn?.(
        `[fb-messenger] account ${account.accountId} not configured (need pageAccessToken + verifyToken) - set FB_MESSENGER_* env or channels.fb-messenger.*`,
      );
      return;
    }
    if (!ctx.channelRuntime) {
      ctx.log?.warn?.("[fb-messenger] channelRuntime unavailable - cannot dispatch to agent");
      return;
    }

    const channelRuntime = ctx.channelRuntime as unknown as ChannelReplyDispatchSurface;

    // ── relay: MonkeyTech Connect giu token, bot chi cam botKey ──────────────────────────────
    if (account.transport === "relay") {
      const relay = await loadRelayCredential();
      if (!relay?.botKey) {
        ctx.log?.warn?.(
          `[fb-messenger] account ${account.accountId}: relay mode but no botKey - open the bot settings and click "Connect Facebook Page" (writes credentials/fb-messenger/relay.json)`,
        );
        ctx.setStatus?.({ accountId: account.accountId, enabled: true, configured: false, reason: "no relay botKey" });
        return;
      }
      const relayUrl = (relay.url || account.relayUrl).replace(/\/+$/, "");
      const sender = createRelaySender({ url: relayUrl, botKey: relay.botKey, pageId: account.pageId });
      const dispose = registerDispatchContext({ account, cfg: ctx.cfg, channelRuntime, sender, log: ctx.log, setStatus: ctx.setStatus });
      const release = acquireRelayLoop({ url: relayUrl, botKey: relay.botKey, log: ctx.log });
      ctx.setStatus?.({ accountId: account.accountId, name: account.name, enabled: true, configured: true, transport: "relay" });
      ctx.log?.info?.(`[fb-messenger] account ${account.accountId} listening via relay ${relayUrl} (page ${account.pageId}${account.instagramId ? `, instagram ${account.instagramId}` : ""})`);
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) return resolve();
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      dispose();
      release();
      return;
    }

    // ── webhook: token Trang o may nay, Meta goi thang vao gateway ───────────────────────────
    // Resolve the effective Page token. Prefer a previously-derived permanent
    // token (persisted in .openclaw/credentials/fb-messenger); otherwise derive
    // one from whatever the user supplied - a short-lived User token from the
    // Graph API Explorer is upgraded to a long-lived one and exchanged for the
    // Page's never-expiring token - and persist it so restarts never re-depend
    // on the (expiring) input token.
    let resolvedFromPersist = false;
    const persisted = await loadPageCredential(account.accountId);
    if (persisted?.pageAccessToken && (await validateToken(persisted.pageAccessToken, account.graphApiVersion))) {
      account.pageAccessToken = persisted.pageAccessToken;
      if (persisted.pageId) account.pageId = persisted.pageId;
      resolvedFromPersist = true;
      ctx.log?.info?.(`[fb-messenger] using saved permanent page token (page ${account.pageId || "?"})`);
    } else if (persisted) {
      await clearPageCredential(account.accountId);
      ctx.log?.warn?.("[fb-messenger] saved page token invalid - re-deriving from configured token");
    }

    if (!resolvedFromPersist) {
      const resolved = await resolvePermanentPageContext(account.pageAccessToken, {
        appId: account.appId,
        appSecret: account.appSecret,
        configuredPageId: account.pageId,
        graphApiVersion: account.graphApiVersion,
      });
      if (resolved) {
        if (resolved.pageId && resolved.pageId !== account.pageId) {
          ctx.log?.info?.(
            `[fb-messenger] resolved page id ${resolved.pageId} (config had "${account.pageId || "?"}")`,
          );
          account.pageId = resolved.pageId;
        }
        account.pageAccessToken = resolved.pageAccessToken;
        if (resolved.permanent) {
          await savePageCredential(account.accountId, {
            pageId: resolved.pageId,
            pageAccessToken: resolved.pageAccessToken,
            derivedAt: new Date().toISOString(),
          });
          ctx.log?.info?.(`[fb-messenger] derived & saved permanent page token (page ${resolved.pageId})`);
        } else {
          ctx.log?.warn?.(
            "[fb-messenger] derived a Page token but it is NOT permanent - set FB_MESSENGER_APP_ID + FB_MESSENGER_APP_SECRET for a never-expiring token",
          );
        }
      } else {
        ctx.log?.warn?.(
          "[fb-messenger] could not resolve page from token - it may be expired/invalid. Re-enter the token (with App ID + App Secret) when editing the bot.",
        );
      }
    }

    // Auto-subscribe the Page to this app's webhook (idempotent) so the user
    // doesn't have to do it manually in the Meta dashboard.
    if (account.pageId) {
      void subscribePageToApp(account.pageId, {
        pageAccessToken: account.pageAccessToken,
        graphApiVersion: account.graphApiVersion,
      }).then((r) => {
        if (r.ok) ctx.log?.info?.(`[fb-messenger] page ${account.pageId} subscribed to app webhook`);
        else ctx.log?.warn?.(`[fb-messenger] page subscribe skipped: ${r.error}`);
      });
    }

    const dispose = registerDispatchContext({
      account,
      cfg: ctx.cfg,
      channelRuntime,
      sender: createGraphSender(account),
      log: ctx.log,
      setStatus: ctx.setStatus,
    });
    ctx.setStatus?.({
      accountId: account.accountId,
      name: account.name,
      enabled: true,
      configured: true,
    });
    ctx.log?.info?.(
      `[fb-messenger] account ${account.accountId} listening (page ${account.pageId || "?"}) - webhook /webhooks/messenger`,
    );

    await new Promise<void>((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    dispose();
  },
};

// ── assemble the channel plugin ───────────────────────────────────────────────
// The base satisfies the structural ChannelPlugin shape; SDK adapter types are
// heavily aliased across bundled chunks, so a single boundary cast keeps the
// public composition readable while the runtime shape stays correct.
// ── outbound adapter: agent nhan chu dong (tool `message`, cron, delivery cua skill) ─────────
// `to` co dang "fb-messenger:<psid>", "<psid>" hoac "ig:<igsid>" (Instagram, nhu peer id inbound).
function parseOutboundTarget(raw: string): { id: string; platform: MessengerPlatform } {
  let id = String(raw ?? "").trim();
  if (id.startsWith(`${CHANNEL_ID}:`)) id = id.slice(CHANNEL_ID.length + 1);
  if (id.startsWith("ig:")) return { id: id.slice(3), platform: "instagram" };
  return { id, platform: "messenger" };
}

function outboundContext(accountId: string | undefined): MessengerDispatchContext | undefined {
  return getDispatchContextForAccount(normalizeAccountId(accountId));
}

const notRunning = (accountId: string | undefined) => ({
  channel: CHANNEL_ID,
  ok: false,
  messageId: "",
  error: new Error(`[fb-messenger] account ${normalizeAccountId(accountId)} is not running (no sender registered)`),
});

const messengerOutbound = {
  deliveryMode: "direct",
  chunker: (text: string, limit: number) => chunkMessengerText(text, limit > 0 ? limit : undefined),
  chunkerMode: "markdown",
  textChunkLimit: 2000,
  sendText: async ({ to, text, accountId }: { to: string; text: string; accountId?: string; cfg?: unknown }) => {
    const ctx = outboundContext(accountId);
    if (!ctx) return notRunning(accountId);
    const target = parseOutboundTarget(to);
    const r = await ctx.sender.sendText(target.id, text ?? "", target.platform);
    return { channel: CHANNEL_ID, ok: r.ok, messageId: r.messageId ?? "", error: r.ok ? undefined : new Error(describeSendError(r)) };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId }: { to: string; text?: string; mediaUrl?: string; accountId?: string; cfg?: unknown }) => {
    const ctx = outboundContext(accountId);
    if (!ctx) return notRunning(accountId);
    const target = parseOutboundTarget(to);
    let last: SendResult = { ok: true };
    if (mediaUrl) {
      if (!/^https:\/\//.test(mediaUrl)) {
        return { channel: CHANNEL_ID, ok: false, messageId: "", error: new Error("[fb-messenger] Messenger only accepts media by public https URL; local files are not supported yet") };
      }
      last = await ctx.sender.sendMedia(target.id, mediaUrl, guessMediaType(mediaUrl), target.platform);
      if (!last.ok) return { channel: CHANNEL_ID, ok: false, messageId: "", error: new Error(describeSendError(last)) };
    }
    const caption = (text ?? "").trim();
    if (caption) last = await ctx.sender.sendText(target.id, caption, target.platform);
    return { channel: CHANNEL_ID, ok: last.ok, messageId: last.messageId ?? "", error: last.ok ? undefined : new Error(describeSendError(last)) };
  },
};

const base = {
  id: CHANNEL_ID,
  meta: messengerMeta,
  capabilities: messengerCapabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: messengerConfigAdapter,
  setup: messengerSetupAdapter,
  gateway: messengerGateway,
  outbound: messengerOutbound,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const messengerPlugin = createChatChannelPlugin({
  base,
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account: ResolvedMessengerAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedMessengerAccount) => account.allowFrom,
      defaultPolicy: "open",
    },
  },
  threading: { topLevelReplyToMode: "off" },
});

export { messengerDmResolver, messengerOutbound, parseOutboundTarget };
export type { MessengerSender };
