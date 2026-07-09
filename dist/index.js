// index.ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

// src/channel.ts
import {
  createChatChannelPlugin
} from "openclaw/plugin-sdk/channel-core";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
  formatTrimmedAllowFromEntries
} from "openclaw/plugin-sdk/channel-config-helpers";

// src/config.ts
var CHANNEL_ID = "fb-messenger";
var DEFAULT_ACCOUNT_ID = "default";
var DEFAULT_GRAPH_API_VERSION = "v21.0";
var MESSENGER_TEXT_LIMIT = 2e3;
function readChannelConfig(cfg) {
  const channels = cfg.channels ?? {};
  return channels[CHANNEL_ID] ?? {};
}
function normalizeAccountId(accountId) {
  const trimmed = (accountId ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}
function listMessengerAccountIds(cfg) {
  const channel = readChannelConfig(cfg);
  const ids = Object.keys(channel.accounts ?? {});
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}
function pick(...values) {
  for (const v of values) if (v !== void 0 && v !== "") return v;
  return void 0;
}
function resolveMessengerAccount(params) {
  const env = params.env ?? process.env;
  const channel = readChannelConfig(params.cfg);
  const accountId = normalizeAccountId(
    params.accountId ?? channel.defaultAccount ?? DEFAULT_ACCOUNT_ID
  );
  const account = channel.accounts?.[accountId] ?? {};
  const pageAccessToken = pick(env.FB_MESSENGER_PAGE_ACCESS_TOKEN, account.pageAccessToken, channel.pageAccessToken) ?? "";
  const appId = pick(env.FB_MESSENGER_APP_ID, account.appId, channel.appId) ?? "";
  const appSecret = pick(env.FB_MESSENGER_APP_SECRET, account.appSecret, channel.appSecret) ?? "";
  const verifyToken = pick(env.FB_MESSENGER_VERIFY_TOKEN, account.verifyToken, channel.verifyToken) ?? "";
  return {
    accountId,
    name: pick(account.name, channel.name),
    enabled: account.enabled ?? channel.enabled ?? true,
    pageId: pick(account.pageId, channel.pageId) ?? "",
    pageAccessToken,
    appId,
    appSecret,
    verifyToken,
    graphApiVersion: pick(account.graphApiVersion, channel.graphApiVersion) ?? DEFAULT_GRAPH_API_VERSION,
    dmPolicy: pick(account.dmPolicy, channel.dmPolicy) ?? "open",
    allowFrom: account.allowFrom ?? channel.allowFrom ?? ["*"],
    historyLimit: account.historyLimit ?? channel.historyLimit ?? 50,
    config: { ...channel, ...account }
  };
}
function isAccountConfigured(account) {
  return Boolean(account.pageAccessToken && account.verifyToken);
}
function isSenderAllowed(account, senderId) {
  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "open") return true;
  const allow = account.allowFrom.map((e) => e.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return allow.includes(senderId.trim());
}

// src/graph-api.ts
var GRAPH_HOST = "https://graph.facebook.com";
function graphUrl(path, version, token) {
  const v = version || DEFAULT_GRAPH_API_VERSION;
  const sep = path.includes("?") ? "&" : "?";
  return `${GRAPH_HOST}/${v}${path}${sep}access_token=${encodeURIComponent(token)}`;
}
function chunkMessengerText(text, limit = MESSENGER_TEXT_LIMIT) {
  const trimmed = text ?? "";
  if (trimmed.length <= limit) return trimmed.length ? [trimmed] : [];
  const chunks = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}
async function postSendApi(body, opts) {
  const url = graphUrl("/me/messages", opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, opts.pageAccessToken);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    return { ok: false, error: json.error?.message || `Graph API HTTP ${res.status}` };
  }
  return { ok: true, messageId: json.message_id, recipientId: json.recipient_id };
}
async function sendMessengerText(to, text, opts) {
  const chunks = chunkMessengerText(text);
  if (chunks.length === 0) return { ok: true };
  let last = { ok: true };
  for (const chunk of chunks) {
    last = await postSendApi(
      {
        messaging_type: "RESPONSE",
        recipient: { id: to },
        message: { text: chunk }
      },
      opts
    );
    if (!last.ok) return last;
  }
  return last;
}
async function sendMessengerMedia(to, mediaUrl, opts) {
  return postSendApi(
    {
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message: {
        attachment: {
          type: opts.mediaType ?? "image",
          payload: { url: mediaUrl, is_reusable: true }
        }
      }
    },
    opts
  );
}
async function sendSenderAction(to, action, opts) {
  return postSendApi({ recipient: { id: to }, sender_action: action }, opts);
}
async function validateToken(token, graphApiVersion) {
  if (!token) return false;
  try {
    const res = await fetch(graphUrl("/me?fields=id", graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, token));
    if (!res.ok) return false;
    const json = await res.json().catch(() => ({}));
    return Boolean(json.id) && !json.error;
  } catch {
    return false;
  }
}
async function exchangeLongLivedUserToken(token, opts) {
  if (!token || !opts.appId || !opts.appSecret) return null;
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  try {
    const url = `${GRAPH_HOST}/${version}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(opts.appId)}&client_secret=${encodeURIComponent(opts.appSecret)}&fb_exchange_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) return json.access_token;
  } catch {
  }
  return null;
}
async function resolvePermanentPageContext(token, opts) {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const longLived = await exchangeLongLivedUserToken(token, {
    appId: opts.appId,
    appSecret: opts.appSecret,
    graphApiVersion: version
  });
  const userToken = longLived ?? token;
  const permanentSource = Boolean(longLived);
  try {
    const res = await fetch(graphUrl("/me/accounts?fields=id,access_token,name", version, userToken));
    const json = await res.json().catch(() => ({}));
    const pages = json.data ?? [];
    if (pages.length > 0) {
      const match = opts.configuredPageId && pages.find((p) => p.id === opts.configuredPageId) || pages[0];
      if (match?.id && match.access_token) {
        return { pageId: match.id, pageAccessToken: match.access_token, permanent: permanentSource };
      }
    }
  } catch {
  }
  try {
    const meRes = await fetch(graphUrl("/me?fields=id", version, token));
    const me = await meRes.json().catch(() => ({}));
    if (me.id) return { pageId: me.id, pageAccessToken: token, permanent: true };
  } catch {
  }
  return null;
}
async function subscribePageToApp(pageId, opts) {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const fields = opts.fields ?? "messages,messaging_postbacks";
  try {
    const url = graphUrl(`/${encodeURIComponent(pageId)}/subscribed_apps`, version, opts.pageAccessToken);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: fields })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: json.success !== false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
async function getUserProfile(psid, opts) {
  const url = graphUrl(
    `/${encodeURIComponent(psid)}?fields=first_name,last_name`,
    opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION,
    opts.pageAccessToken
  );
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const name = [json.first_name, json.last_name].filter(Boolean).join(" ").trim();
    return { id: json.id ?? psid, name: name || void 0 };
  } catch {
    return null;
  }
}

// src/credentials.ts
import { promises as fs } from "fs";
import { dirname, join } from "path";
function stateDir() {
  return process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR || join(process.cwd(), ".openclaw");
}
function credentialPath(accountId) {
  const file = !accountId || accountId === "default" ? "credentials.json" : `credentials-${accountId}.json`;
  return join(stateDir(), "credentials", CHANNEL_ID, file);
}
async function loadPageCredential(accountId) {
  try {
    const raw = await fs.readFile(credentialPath(accountId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.pageAccessToken) return parsed;
  } catch {
  }
  return null;
}
async function savePageCredential(accountId, cred) {
  const path = credentialPath(accountId);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ ...cred, derivedAt: cred.derivedAt }, null, 2), "utf8");
  } catch {
  }
}
async function clearPageCredential(accountId) {
  try {
    await fs.rm(credentialPath(accountId), { force: true });
  } catch {
  }
}

// src/registry.ts
var byPageId = /* @__PURE__ */ new Map();
function registerDispatchContext(ctx) {
  const pageId = ctx.account.pageId?.trim();
  if (!pageId) {
    ctx.log?.warn?.(
      `[fb-messenger] account ${ctx.account.accountId} has no pageId \u2014 webhook routing disabled for it`
    );
    return () => {
    };
  }
  byPageId.set(pageId, ctx);
  return () => {
    if (byPageId.get(pageId) === ctx) byPageId.delete(pageId);
  };
}
function getDispatchContextForPage(pageId) {
  return byPageId.get(pageId.trim());
}
function findContextByVerifyToken(token) {
  const t = token.trim();
  if (!t) return void 0;
  for (const ctx of byPageId.values()) {
    if (ctx.account.verifyToken && ctx.account.verifyToken.trim() === t) return ctx;
  }
  return void 0;
}
function hasRegisteredAccounts() {
  return byPageId.size > 0;
}
function getSoleContext() {
  return byPageId.size === 1 ? [...byPageId.values()][0] : void 0;
}

// src/channel.ts
var messengerMeta = {
  id: CHANNEL_ID,
  label: "Facebook Messenger",
  selectionLabel: "Facebook (Messenger)",
  docsPath: "/channels/fb-messenger",
  docsLabel: "fb-messenger",
  blurb: "Facebook Page Messenger via webhook + Graph API.",
  aliases: ["fb", "messenger"],
  order: 90,
  quickstartAllowFrom: false
};
var messengerCapabilities = {
  chatTypes: ["direct"],
  media: true,
  reactions: false,
  threads: false,
  polls: false,
  nativeCommands: false,
  blockStreaming: true
};
var messengerConfigAdapter = createHybridChannelConfigAdapter({
  sectionKey: CHANNEL_ID,
  listAccountIds: (cfg) => listMessengerAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveMessengerAccount({ cfg, accountId }),
  defaultAccountId: (cfg) => {
    const channels = cfg.channels;
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
    "responsePrefix"
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom)
});
var messengerDmResolver = createScopedDmSecurityResolver({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom
});
var messengerSetupAdapter = {
  applyAccountConfig: (params) => {
    const cfg = params.cfg;
    const channels = { ...cfg.channels ?? {} };
    const existing = channels[CHANNEL_ID] ?? {};
    const input = params.input;
    channels[CHANNEL_ID] = {
      ...existing,
      enabled: true,
      ...input.pageId ? { pageId: input.pageId } : {},
      ...input.pageAccessToken ? { pageAccessToken: input.pageAccessToken } : {},
      ...input.appId ? { appId: input.appId } : {},
      ...input.appSecret ? { appSecret: input.appSecret } : {},
      ...input.verifyToken ? { verifyToken: input.verifyToken } : {},
      dmPolicy: existing.dmPolicy ?? "open",
      allowFrom: existing.allowFrom ?? ["*"]
    };
    return { ...cfg, channels };
  }
};
var messengerGateway = {
  startAccount: async (ctx) => {
    const account = resolveMessengerAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
    if (!account.enabled) return;
    if (!isAccountConfigured(account)) {
      ctx.log?.warn?.(
        `[fb-messenger] account ${account.accountId} not configured (need pageAccessToken + verifyToken) \u2014 set FB_MESSENGER_* env or channels.fb-messenger.*`
      );
      return;
    }
    if (!ctx.channelRuntime) {
      ctx.log?.warn?.("[fb-messenger] channelRuntime unavailable \u2014 cannot dispatch to agent");
      return;
    }
    const channelRuntime = ctx.channelRuntime;
    let resolvedFromPersist = false;
    const persisted = await loadPageCredential(account.accountId);
    if (persisted?.pageAccessToken && await validateToken(persisted.pageAccessToken, account.graphApiVersion)) {
      account.pageAccessToken = persisted.pageAccessToken;
      if (persisted.pageId) account.pageId = persisted.pageId;
      resolvedFromPersist = true;
      ctx.log?.info?.(`[fb-messenger] using saved permanent page token (page ${account.pageId || "?"})`);
    } else if (persisted) {
      await clearPageCredential(account.accountId);
      ctx.log?.warn?.("[fb-messenger] saved page token invalid \u2014 re-deriving from configured token");
    }
    if (!resolvedFromPersist) {
      const resolved = await resolvePermanentPageContext(account.pageAccessToken, {
        appId: account.appId,
        appSecret: account.appSecret,
        configuredPageId: account.pageId,
        graphApiVersion: account.graphApiVersion
      });
      if (resolved) {
        if (resolved.pageId && resolved.pageId !== account.pageId) {
          ctx.log?.info?.(
            `[fb-messenger] resolved page id ${resolved.pageId} (config had "${account.pageId || "?"}")`
          );
          account.pageId = resolved.pageId;
        }
        account.pageAccessToken = resolved.pageAccessToken;
        if (resolved.permanent) {
          await savePageCredential(account.accountId, {
            pageId: resolved.pageId,
            pageAccessToken: resolved.pageAccessToken,
            derivedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
          ctx.log?.info?.(`[fb-messenger] derived & saved permanent page token (page ${resolved.pageId})`);
        } else {
          ctx.log?.warn?.(
            "[fb-messenger] derived a Page token but it is NOT permanent \u2014 set FB_MESSENGER_APP_ID + FB_MESSENGER_APP_SECRET for a never-expiring token"
          );
        }
      } else {
        ctx.log?.warn?.(
          "[fb-messenger] could not resolve page from token \u2014 it may be expired/invalid. Re-enter the token (with App ID + App Secret) when editing the bot."
        );
      }
    }
    if (account.pageId) {
      void subscribePageToApp(account.pageId, {
        pageAccessToken: account.pageAccessToken,
        graphApiVersion: account.graphApiVersion
      }).then((r) => {
        if (r.ok) ctx.log?.info?.(`[fb-messenger] page ${account.pageId} subscribed to app webhook`);
        else ctx.log?.warn?.(`[fb-messenger] page subscribe skipped: ${r.error}`);
      });
    }
    const dispose = registerDispatchContext({
      account,
      cfg: ctx.cfg,
      channelRuntime,
      log: ctx.log
    });
    ctx.setStatus?.({
      accountId: account.accountId,
      name: account.name,
      enabled: true,
      configured: true
    });
    ctx.log?.info?.(
      `[fb-messenger] account ${account.accountId} listening (page ${account.pageId || "?"}) \u2014 webhook /webhooks/messenger`
    );
    await new Promise((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    dispose();
  }
};
var base = {
  id: CHANNEL_ID,
  meta: messengerMeta,
  capabilities: messengerCapabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: messengerConfigAdapter,
  setup: messengerSetupAdapter,
  gateway: messengerGateway
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
};
var messengerPlugin = createChatChannelPlugin({
  base,
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "open"
    }
  },
  threading: { topLevelReplyToMode: "off" }
});

// src/webhook.ts
import { createHmac, timingSafeEqual } from "crypto";

// src/inbound.ts
function extractText(event) {
  if (event.message?.is_echo) return void 0;
  const fromMessage = event.message?.text?.trim();
  if (fromMessage) return fromMessage;
  const fromQuickReply = event.message?.quick_reply?.payload?.trim();
  if (fromQuickReply) return fromQuickReply;
  const fromPostback = event.postback?.payload?.trim() || event.postback?.title?.trim();
  return fromPostback || void 0;
}
async function dispatchMessengerEvent(ctx, event) {
  const { account, cfg, channelRuntime, log } = ctx;
  const senderId = event.sender?.id?.trim();
  if (!senderId) return;
  const text = extractText(event);
  if (!text) return;
  if (!isSenderAllowed(account, senderId)) {
    log?.info?.(`[fb-messenger] drop message from ${senderId} (dmPolicy=${account.dmPolicy})`);
    return;
  }
  const sendOpts = {
    pageAccessToken: account.pageAccessToken,
    graphApiVersion: account.graphApiVersion
  };
  void sendSenderAction(senderId, "mark_seen", sendOpts).catch(() => {
  });
  void sendSenderAction(senderId, "typing_on", sendOpts).catch(() => {
  });
  const profile = await getUserProfile(senderId, sendOpts).catch(() => null);
  const senderName = profile?.name;
  const messageId = event.message?.mid || event.postback?.mid || `${event.timestamp ?? ""}`;
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: senderId }
  });
  const cfgSession = cfg.session;
  const storePath = channelRuntime.session.resolveStorePath(cfgSession?.store, {
    agentId: route.agentId
  });
  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    messageId,
    timestamp: event.timestamp,
    from: `${CHANNEL_ID}:${senderId}`,
    sender: { id: senderId, name: senderName },
    conversation: { kind: "direct", id: senderId, label: senderName || senderId },
    route: {
      agentId: route.agentId,
      accountId: route.accountId ?? account.accountId,
      routeSessionKey: route.sessionKey
    },
    reply: {
      to: `${CHANNEL_ID}:${senderId}`,
      originatingTo: `${CHANNEL_ID}:${senderId}`
    },
    message: {
      body: text,
      bodyForAgent: text,
      rawBody: text,
      commandBody: text
    }
  });
  const deliver = async (payload) => {
    if (payload.mediaUrl) {
      const r = await sendMessengerMedia(senderId, payload.mediaUrl, sendOpts);
      if (!r.ok) log?.error?.(`[fb-messenger] media send failed: ${r.error}`);
    }
    const replyText = payload.text?.trim();
    if (replyText) {
      const r = await sendMessengerText(senderId, replyText, sendOpts);
      if (!r.ok) log?.error?.(`[fb-messenger] text send failed: ${r.error}`);
      return r;
    }
    return { ok: true };
  };
  try {
    await channelRuntime.inbound.dispatchReply({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      cfg,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: channelRuntime.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher: channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver }
    });
  } catch (err) {
    log?.error?.(`[fb-messenger] dispatch failed for ${senderId}: ${String(err)}`);
  } finally {
    void sendSenderAction(senderId, "typing_off", sendOpts).catch(() => {
    });
  }
}

// src/webhook.ts
var WEBHOOK_PATH = "/webhooks/messenger";
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true;
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function send(res, status, body = "") {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}
async function handleMessengerWebhook(req, res) {
  const url = new URL(req.url ?? "", "http://localhost");
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && findContextByVerifyToken(token)) {
      send(res, 200, challenge);
    } else {
      send(res, 403, "Forbidden");
    }
    return true;
  }
  if (req.method === "POST") {
    const rawBody = await readRawBody(req).catch(() => Buffer.alloc(0));
    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      send(res, 400, "Bad Request");
      return true;
    }
    if (body.object !== "page" || !Array.isArray(body.entry)) {
      send(res, 200, "EVENT_RECEIVED");
      return true;
    }
    send(res, 200, "EVENT_RECEIVED");
    if (!hasRegisteredAccounts()) return true;
    const signature = req.headers["x-hub-signature-256"];
    for (const entry of body.entry) {
      const ctx = getDispatchContextForPage(entry.id ?? "") ?? getSoleContext();
      if (!ctx) continue;
      if (!verifySignature(rawBody, signature, ctx.account.appSecret)) {
        ctx.log?.warn?.(`[fb-messenger] signature mismatch for page ${entry.id} \u2014 dropping`);
        continue;
      }
      for (const event of entry.messaging ?? []) {
        void dispatchMessengerEvent(ctx, event).catch((err) => {
          ctx.log?.error?.(`[fb-messenger] event handling error: ${String(err)}`);
        });
      }
    }
    return true;
  }
  send(res, 405, "Method Not Allowed");
  return true;
}

// index.ts
var index_default = defineChannelPluginEntry({
  id: "fb-messenger",
  name: "Facebook Messenger",
  description: "Facebook Page Messenger via webhook + Graph API (AI handled by the OpenClaw agent).",
  plugin: messengerPlugin,
  registerFull(api) {
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      handler: handleMessengerWebhook
    });
  }
});
export {
  index_default as default
};
