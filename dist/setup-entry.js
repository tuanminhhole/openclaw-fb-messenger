// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

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
var DEFAULT_GRAPH_API_VERSION = "v24.0";
var MESSENGER_TEXT_LIMIT = 2e3;
var DEFAULT_RELAY_URL = "https://connect.monkeytech.vn";
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
  const relayUrl = (pick(env.FB_MESSENGER_RELAY_URL, account.relayUrl, channel.relayUrl) ?? DEFAULT_RELAY_URL).replace(/\/+$/, "");
  const explicit = pick(env.FB_MESSENGER_TRANSPORT, account.transport, channel.transport);
  const transport = explicit === "webhook" || explicit === "relay" ? explicit : pageAccessToken ? "webhook" : "relay";
  const pageId = pick(account.pageId, channel.pageId) ?? (transport === "relay" && accountId !== DEFAULT_ACCOUNT_ID ? accountId : "");
  const messagesCfg = params.cfg.messages;
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
    graphApiVersion: pick(account.graphApiVersion, channel.graphApiVersion) ?? DEFAULT_GRAPH_API_VERSION,
    dmPolicy: pick(account.dmPolicy, channel.dmPolicy) ?? "open",
    allowFrom: account.allowFrom ?? channel.allowFrom ?? ["*"],
    historyLimit: account.historyLimit ?? channel.historyLimit ?? 50,
    transport,
    relayUrl,
    instagramId: pick(account.instagramId, channel.instagramId) ?? "",
    ackReaction: normalizeAckReaction(rawAck),
    config: { ...channel, ...account }
  };
}
function isAccountConfigured(account) {
  if (account.transport === "relay") return Boolean(account.pageId);
  return Boolean(account.pageAccessToken && account.verifyToken);
}
var ZALO_REACTION_EMOJI = {
  "/-heart": "\u2764\uFE0F",
  "/-strong": "\u{1F44D}",
  ":>": "\u{1F606}",
  ":-((": "\u{1F622}",
  ":o": "\u{1F62E}",
  ":-h": "\u{1F621}",
  "/-remove": ""
};
function normalizeAckReaction(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (v in ZALO_REACTION_EMOJI) return ZALO_REACTION_EMOJI[v] ?? "";
  return /^[^\x00-\x7F]{1,8}$/u.test(v) ? v : "";
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
async function sendMessengerReaction(to, messageId, emoji, opts) {
  return postSendApi({ recipient: { id: to }, sender_action: "react", payload: { message_id: messageId, reaction: emoji } }, opts);
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
function relayPath() {
  return join(stateDir(), "credentials", CHANNEL_ID, "relay.json");
}
function relayCursorPath() {
  return join(stateDir(), "credentials", CHANNEL_ID, "relay-cursor.json");
}
async function loadRelayCredential(env = process.env) {
  const fromEnv = (env.FB_MESSENGER_RELAY_KEY ?? "").trim();
  if (fromEnv) return { botKey: fromEnv, url: (env.FB_MESSENGER_RELAY_URL ?? "").trim() || void 0 };
  try {
    const parsed = JSON.parse(await fs.readFile(relayPath(), "utf8"));
    if (parsed?.botKey) return parsed;
  } catch {
  }
  return null;
}
async function loadRelayCursor() {
  try {
    const parsed = JSON.parse(await fs.readFile(relayCursorPath(), "utf8"));
    return typeof parsed?.cursor === "number" ? parsed.cursor : null;
  } catch {
    return null;
  }
}
async function saveRelayCursor(cursor) {
  const path = relayCursorPath();
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ cursor, savedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
  } catch {
  }
}

// src/registry.ts
function getDispatchContextForAccount(accountId) {
  for (const ctx of byPageId.values()) if (ctx.account.accountId === accountId) return ctx;
  return void 0;
}
var byPageId = /* @__PURE__ */ new Map();
function registerDispatchContext(ctx) {
  const pageId = ctx.account.pageId?.trim();
  if (!pageId) {
    ctx.log?.warn?.(
      `[fb-messenger] account ${ctx.account.accountId} has no pageId - webhook routing disabled for it`
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
function hasRegisteredAccounts() {
  return byPageId.size > 0;
}

// src/connect-api.ts
async function connectCall(relay, path, init = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${relay.url.replace(/\/+$/, "")}${path}`, {
      method: init.method ?? (init.body === void 0 ? "GET" : "POST"),
      headers: { authorization: `Bearer ${relay.botKey}`, "content-type": "application/json" },
      body: init.body === void 0 ? void 0 : JSON.stringify(init.body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) return { ok: true, status: res.status, data };
    const err = data.error;
    return {
      ok: false,
      status: res.status,
      data,
      error: typeof err === "string" ? err : err?.message || `Connect HTTP ${res.status}`,
      upgradeUrl: res.status === 402 ? String(data.billingUrl || "") : void 0
    };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: String(e) };
  }
}
var page = (id) => `/api/pages/${encodeURIComponent(id)}`;
var replyComment = (r, pageId, commentId, message, isPrivate = false, f) => connectCall(r, `${page(pageId)}/comments/${encodeURIComponent(commentId)}/replies`, { body: { message, private: isPrivate } }, f);
var settingsCache = /* @__PURE__ */ new Map();
async function pageSettings(r, pageId, f) {
  const hit = settingsCache.get(pageId);
  if (hit && Date.now() - hit.at < 6e4) return hit.value;
  const res = await connectCall(r, `${page(pageId)}/settings`, {}, f);
  const s = res.data.settings ?? {};
  const value = { commentReply: s.commentReply !== false, privateReply: s.privateReply === true };
  settingsCache.set(pageId, { at: Date.now(), value });
  return value;
}

// src/inbound.ts
var SEEN_LIMIT = 5e3;
var seenMids = /* @__PURE__ */ new Set();
function rememberMid(mid) {
  if (seenMids.has(mid)) return false;
  seenMids.add(mid);
  if (seenMids.size > SEEN_LIMIT) {
    const first = seenMids.values().next().value;
    if (first !== void 0) seenMids.delete(first);
  }
  return true;
}
var ATTACHMENT_LABEL = {
  image: "\u1EA2nh",
  video: "Video",
  audio: "\xC2m thanh",
  file: "T\u1EC7p",
  location: "V\u1ECB tr\xED",
  fallback: "Li\xEAn k\u1EBFt",
  template: "M\u1EABu",
  reel: "Reel",
  story_mention: "Nh\u1EAFc trong story",
  ig_reel: "Reel"
};
function extractBody(event) {
  if (event.message?.is_echo) return void 0;
  if (event.message?.is_deleted) return void 0;
  const parts = [];
  const text = event.message?.text?.trim();
  if (text) parts.push(text);
  else {
    const qr = event.message?.quick_reply?.payload?.trim();
    if (qr) parts.push(qr);
  }
  const seenUrls = /* @__PURE__ */ new Set();
  for (const a of event.message?.attachments ?? []) {
    const type = (a.type ?? "").toLowerCase();
    if (!type || ["template", "unsupported_type", "ephemeral"].includes(type)) continue;
    const url = a.payload?.url?.trim();
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);
    const label = ATTACHMENT_LABEL[type] ?? type;
    parts.push(url ? `[${label}] ${url}` : `[${label}]`);
  }
  if (!parts.length) {
    const pb = event.postback?.payload?.trim() || event.postback?.title?.trim();
    if (pb) parts.push(pb);
  }
  return parts.length ? parts.join("\n") : void 0;
}
async function dispatchMessengerEvent(ctx, event, options = {}) {
  const { account, cfg, channelRuntime, sender, log } = ctx;
  const platform = options.platform ?? "messenger";
  const senderId = event.sender?.id?.trim();
  if (!senderId) return;
  const mid = event.message?.mid || event.postback?.mid;
  if (mid && !rememberMid(`${account.pageId}:${mid}`)) {
    log?.info?.(`[fb-messenger] duplicate ${mid} ignored`);
    return;
  }
  const text = extractBody(event);
  if (!text) return;
  lastCustomer.set(account.pageId, { id: senderId, platform });
  if (!isSenderAllowed(account, senderId)) {
    log?.info?.(`[fb-messenger] drop message from ${senderId} (dmPolicy=${account.dmPolicy})`);
    return;
  }
  if (account.ackReaction && mid) {
    void sender.react(senderId, mid, account.ackReaction, platform).catch(() => {
    });
  }
  void sender.senderAction(senderId, "mark_seen", platform).catch(() => {
  });
  void sender.senderAction(senderId, "typing_on", platform).catch(() => {
  });
  const typingTimer = setInterval(() => {
    void sender.senderAction(senderId, "typing_on", platform).catch(() => {
    });
  }, TYPING_KEEPALIVE_MS);
  const profile = await sender.getProfile(senderId, platform).catch(() => null);
  const senderName = profile?.name;
  const messageId = mid || `${event.timestamp ?? Date.now()}`;
  const label = `${senderName || senderId}${platform === "instagram" ? " (Instagram)" : ""}`;
  const peerId = platform === "instagram" ? `ig:${senderId}` : senderId;
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: peerId }
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
    from: `${CHANNEL_ID}:${peerId}`,
    sender: { id: peerId, name: senderName },
    conversation: { kind: "direct", id: peerId, label },
    route: {
      agentId: route.agentId,
      accountId: route.accountId ?? account.accountId,
      routeSessionKey: route.sessionKey
    },
    reply: {
      to: `${CHANNEL_ID}:${peerId}`,
      originatingTo: `${CHANNEL_ID}:${peerId}`
    },
    message: {
      body: text,
      bodyForAgent: text,
      rawBody: text,
      commandBody: text
    }
  });
  const deliver = async (payload) => {
    if (isSystemErrorReply(payload.text)) {
      log?.error?.(`[fb-messenger] model/provider error for ${senderId} (not sent to customer): ${String(payload.text).slice(0, 200)}`);
      return { ok: false, error: "system error suppressed" };
    }
    if (payload.mediaUrl) {
      const r = await sender.sendMedia(senderId, payload.mediaUrl, guessMediaType(payload.mediaUrl), platform);
      if (!r.ok) log?.error?.(`[fb-messenger] media send failed: ${r.error}`);
    }
    const replyText = payload.text?.trim();
    if (replyText) {
      const r = await sender.sendText(senderId, replyText, platform);
      if (!r.ok) log?.error?.(`[fb-messenger] text send failed: ${describeSendError(r)}`);
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
    clearInterval(typingTimer);
    void sender.senderAction(senderId, "typing_off", platform).catch(() => {
    });
  }
}
var TYPING_KEEPALIVE_MS = 1e4;
function isSystemErrorReply(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t.startsWith("\u26A0\uFE0F")) return false;
  return /HTTP \d{3}|API key|provider|Authentication|billing|rate limit|quota|temporar|request failed|returned a|9router|model/i.test(t);
}
function guessMediaType(url) {
  const ext = (url.split("?")[0] ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "ogg", "aac"].includes(ext)) return "audio";
  return ext ? "file" : "image";
}
function describeSendError(r) {
  if (r.code === 409) return `page disconnected from Connect - owner must connect again (${r.error})`;
  if (r.code === 10 && r.subcode === 2018278) return `outside the 24h messaging window (${r.error})`;
  if (r.code === 190) return `page token invalid/expired (${r.error})`;
  if (r.code === 613 || r.code === 4) return `rate limited by Meta (${r.error})`;
  if (r.code === 551) return `recipient unavailable or blocked the Page (${r.error})`;
  return r.error ?? "unknown error";
}
var lastCustomer = /* @__PURE__ */ new Map();
async function dispatchCommentEvent(ctx, ev) {
  const { account, cfg, channelRuntime, log } = ctx;
  const relay = ctx.relay;
  const commentId = ev.payload?.comment_id || ev.mid || "";
  const fromId = ev.payload?.from?.id || ev.senderId || "";
  const text = (ev.text || "").trim();
  if (!relay || !commentId || !fromId || !text) return;
  if (fromId === account.pageId) return;
  if (!rememberMid(`${account.pageId}:${commentId}`)) return;
  if (!isSenderAllowed(account, fromId)) return;
  const settings = await pageSettings(relay, account.pageId).catch(() => ({ commentReply: true, privateReply: false }));
  if (!settings.commentReply) return;
  const name = ev.payload?.from?.name || fromId;
  const peerId = `cmt:${fromId}`;
  const body = [
    `[B\xECnh lu\u1EADn c\xF4ng khai tr\xEAn b\xE0i vi\u1EBFt c\u1EE7a Trang${ev.payload?.permalink ? ` (${ev.payload.permalink})` : ""}]`,
    `${name}: ${text}`,
    "",
    settings.privateReply ? "Tr\u1EA3 l\u1EDDi n\xE0y s\u1EBD \u0111\u01B0\u1EE3c g\u1EEDi ri\xEAng qua Messenger cho ng\u01B0\u1EDDi b\xECnh lu\u1EADn. Tr\u1EA3 l\u1EDDi \u0111\u1EA7y \u0111\u1EE7 nh\u01B0 \u0111ang nh\u1EAFn tin ri\xEAng." : "Tr\u1EA3 l\u1EDDi n\xE0y s\u1EBD hi\u1EC7n C\xD4NG KHAI d\u01B0\u1EDBi b\xECnh lu\u1EADn. Vi\u1EBFt ng\u1EAFn g\u1ECDn, l\u1ECBch s\u1EF1; kh\xF4ng \u0111\u01B0a s\u1ED1 \u0111i\u1EC7n tho\u1EA1i, \u0111\u1ECBa ch\u1EC9 hay gi\xE1 ri\xEAng c\u1EE7a kh\xE1ch; n\u1EBFu c\u1EA7n t\u01B0 v\u1EA5n chi ti\u1EBFt th\xEC m\u1EDDi kh\xE1ch nh\u1EAFn tin cho Trang."
  ].join("\n");
  const route = channelRuntime.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: { kind: "direct", id: peerId } });
  const cfgSession = cfg.session;
  const storePath = channelRuntime.session.resolveStorePath(cfgSession?.store, { agentId: route.agentId });
  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    messageId: commentId,
    timestamp: Date.now(),
    from: `${CHANNEL_ID}:${peerId}`,
    sender: { id: peerId, name },
    conversation: { kind: "direct", id: peerId, label: `${name} (b\xECnh lu\u1EADn)` },
    route: { agentId: route.agentId, accountId: route.accountId ?? account.accountId, routeSessionKey: route.sessionKey },
    reply: { to: `${CHANNEL_ID}:${peerId}`, originatingTo: `${CHANNEL_ID}:${peerId}` },
    message: { body, bodyForAgent: body, rawBody: text, commandBody: text }
  });
  let answered = false;
  const deliver = async (payload) => {
    if (isSystemErrorReply(payload.text)) {
      log?.error?.(`[fb-messenger] model/provider error on comment ${commentId} (not posted): ${String(payload.text).slice(0, 200)}`);
      return { ok: false, error: "system error suppressed" };
    }
    const reply = payload.text?.trim();
    if (!reply) return { ok: true };
    if (settings.privateReply && !answered) {
      const priv = await replyComment(relay, account.pageId, commentId, reply, true);
      if (!priv.ok) log?.warn?.(`[fb-messenger] private reply to comment ${commentId} failed: ${priv.error}`);
      const pub = await replyComment(relay, account.pageId, commentId, priv.ok ? "D\u1EA1 shop \u0111\xE3 nh\u1EAFn ri\xEAng cho b\u1EA1n, b\u1EA1n xem tin nh\u1EAFn gi\xFAp shop nh\xE9." : reply);
      answered = true;
      return pub;
    }
    const r = await replyComment(relay, account.pageId, commentId, reply);
    if (!r.ok) log?.error?.(`[fb-messenger] comment reply failed: ${r.error}${r.upgradeUrl ? ` (upgrade: ${r.upgradeUrl})` : ""}`);
    answered = true;
    return r;
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
    log?.error?.(`[fb-messenger] comment dispatch failed for ${commentId}: ${String(err)}`);
  }
}

// src/relay.ts
var loop = null;
function acquireRelayLoop(opts) {
  const key = `${opts.url}|${opts.botKey}`;
  if (loop && loop.key === key && !loop.abort.signal.aborted) {
    loop.refs += 1;
  } else {
    if (loop) loop.abort.abort();
    const abort = new AbortController();
    const state = { key, abort, refs: 1, done: Promise.resolve() };
    state.done = runLoop(opts, abort.signal).catch((e) => opts.log?.error?.(`[fb-messenger] relay loop crashed: ${String(e)}`));
    loop = state;
  }
  const mine = loop;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.refs -= 1;
    if (mine.refs <= 0) {
      mine.abort.abort();
      if (loop === mine) loop = null;
    }
  };
}
var sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(t);
    resolve();
  }, { once: true });
});
async function runLoop(opts, signal) {
  const f = opts.fetchImpl ?? fetch;
  const wait = Math.min(25, Math.max(1, opts.waitSec ?? 25));
  const headers = { authorization: `Bearer ${opts.botKey}` };
  let cursor = await loadRelayCursor();
  let backoffMs = 2e3;
  opts.log?.info?.(`[fb-messenger] relay: polling ${opts.url} (cursor ${cursor ?? "fresh"})`);
  while (!signal.aborted) {
    const since = cursor === null ? "" : `since=${cursor}&wait=${wait}`;
    let res;
    try {
      res = await f(`${opts.url}/api/events${since ? `?${since}` : ""}`, { headers, signal });
    } catch (e) {
      if (signal.aborted) return;
      opts.log?.warn?.(`[fb-messenger] relay: ${String(e)} - retry in ${backoffMs / 1e3}s`);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 6e4);
      continue;
    }
    if (res.status === 401) {
      opts.log?.error?.("[fb-messenger] relay: botKey rejected by Connect (401) - open the bot settings and connect the Facebook Page again");
      await sleep(6e4, signal);
      continue;
    }
    if (!res.ok) {
      opts.log?.warn?.(`[fb-messenger] relay: HTTP ${res.status} - retry in ${backoffMs / 1e3}s`);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 6e4);
      continue;
    }
    backoffMs = 2e3;
    const body = await res.json().catch(() => ({}));
    const events = Array.isArray(body.events) ? body.events : [];
    if (typeof body.cursor === "number" && body.cursor !== cursor) {
      cursor = body.cursor;
      await saveRelayCursor(cursor);
    }
    for (const ev of events) {
      try {
        await handleRelayEvent(ev, opts);
      } catch (e) {
        opts.log?.error?.(`[fb-messenger] relay: event ${ev.id} failed: ${String(e)}`);
      }
    }
    opts.onCycle?.(events);
    if (!hasRegisteredAccounts()) await sleep(1e3, signal);
  }
}
async function handleRelayEvent(ev, opts) {
  if (!ev.pageId) return;
  const ctx = getDispatchContextForPage(ev.pageId);
  if (!ctx) {
    opts.log?.info?.(`[fb-messenger] relay: event for page ${ev.pageId} but no account registered for it`);
    return;
  }
  switch (ev.kind) {
    case "message":
    case "postback": {
      const event = ev.payload;
      if (!event || typeof event !== "object" || !event.sender) return;
      await dispatchMessengerEvent(ctx, event, { platform: ev.object === "instagram" ? "instagram" : "messenger" });
      return;
    }
    case "comment":
      await dispatchCommentEvent(ctx, { pageId: ev.pageId, senderId: ev.senderId, mid: ev.mid, text: ev.text, payload: ev.payload ?? null });
      return;
    case "quota": {
      const p = ev.payload ?? {};
      ctx.log?.warn?.(`[fb-messenger] page ${ev.pageId}: Free plan used ${p.used}/${p.quota} conversations this month${p.level === 100 ? " - new conversations go to the Connect inbox only; upgrade at Connect /billing" : ""}`);
      return;
    }
    case "disconnected":
      ctx.log?.warn?.(`[fb-messenger] page ${ev.pageId} was disconnected from Connect (${ev.text || "deauthorize"}) - replies will fail until the owner connects again`);
      ctx.setStatus?.({ accountId: ctx.account.accountId, enabled: true, configured: true, connected: false, reason: ev.text || "disconnected" });
      return;
    case "token_invalid":
      ctx.log?.warn?.(`[fb-messenger] page ${ev.pageId}: Page token invalid at Connect - owner must connect again`);
      return;
    case "sent":
      ctx.log?.info?.(`[fb-messenger] echo on page ${ev.pageId} to ${ev.senderId ?? "?"}${ev.text ? `: ${ev.text.slice(0, 60)}` : ""}`);
      return;
    default:
      return;
  }
}

// src/sender.ts
var fromGraph = (r) => ({ ok: r.ok, messageId: r.messageId, error: r.error });
function createGraphSender(account) {
  const opts = { pageAccessToken: account.pageAccessToken, graphApiVersion: account.graphApiVersion };
  return {
    react: async (to, messageId, emoji, platform) => fromGraph(await sendMessengerReaction(to, messageId, platform === "instagram" ? "love" : emoji, opts)),
    sendText: async (to, text) => fromGraph(await sendMessengerText(to, text, opts)),
    sendMedia: async (to, url, type) => fromGraph(await sendMessengerMedia(to, url, { ...opts, mediaType: type })),
    senderAction: async (to, action) => fromGraph(await sendSenderAction(to, action, opts)),
    getProfile: (psid) => getUserProfile(psid, opts)
  };
}
async function relayCall(opts, path, init) {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${opts.botKey}`, "content-type": "application/json", ...init.headers ?? {} }
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
function relayResult(status, json) {
  if (json.ok === true) {
    const sent = Array.isArray(json.sent) ? json.sent : [];
    return { ok: true, messageId: sent[sent.length - 1]?.messageId };
  }
  const err = json.error;
  if (typeof err === "string") return { ok: false, error: err, code: status === 409 ? 409 : null };
  return { ok: false, error: err?.message || `Connect HTTP ${status}`, code: err?.code ?? (status === 409 ? 409 : null), subcode: err?.subcode ?? null };
}
function createRelaySender(opts) {
  const post = (body) => relayCall(opts, `/api/pages/${encodeURIComponent(opts.pageId)}/messages`, { method: "POST", body: JSON.stringify(body) }).then(({ status, json }) => relayResult(status, json)).catch((e) => ({ ok: false, error: String(e), code: null }));
  return {
    react: (to, messageId, emoji, platform) => post({ recipientId: to, reaction: { messageId, emoji }, platform }),
    sendText: async (to, text, platform) => {
      let last = { ok: true };
      for (const chunk of chunkMessengerText(text, MESSENGER_TEXT_LIMIT)) {
        last = await post({ recipientId: to, text: chunk, platform });
        if (!last.ok) return last;
      }
      return last;
    },
    sendMedia: (to, url, type, platform) => post({ recipientId: to, attachments: [{ type, url }], platform }),
    senderAction: (to, action, platform) => post({ recipientId: to, senderAction: action, platform }),
    getProfile: async (psid, platform) => {
      try {
        const { status, json } = await relayCall(opts, `/api/pages/${encodeURIComponent(opts.pageId)}/contacts/${encodeURIComponent(psid)}?platform=${platform ?? "messenger"}`, { method: "GET" });
        if (status !== 200 || json.ok !== true) return null;
        const c = json.contact;
        return { id: c?.id ?? psid, name: c?.name || void 0 };
      } catch {
        return null;
      }
    }
  };
}

// src/channel.ts
var messengerMeta = {
  id: CHANNEL_ID,
  label: "Facebook Messenger",
  selectionLabel: "Facebook (Messenger)",
  docsPath: "/channels/fb-messenger",
  docsLabel: "fb-messenger",
  blurb: "Facebook Page Messenger + Instagram via MonkeyTech Connect relay or direct webhook.",
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
    "responsePrefix",
    "transport",
    "relayUrl",
    "instagramId",
    "ackReaction"
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
      ...input.transport ? { transport: input.transport } : {},
      ...input.relayUrl ? { relayUrl: input.relayUrl } : {},
      ...input.instagramId ? { instagramId: input.instagramId } : {},
      ...typeof input.ackReaction === "string" ? { ackReaction: input.ackReaction } : {},
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
        `[fb-messenger] account ${account.accountId} not configured (need pageAccessToken + verifyToken) - set FB_MESSENGER_* env or channels.fb-messenger.*`
      );
      return;
    }
    if (!ctx.channelRuntime) {
      ctx.log?.warn?.("[fb-messenger] channelRuntime unavailable - cannot dispatch to agent");
      return;
    }
    const channelRuntime = ctx.channelRuntime;
    if (account.transport === "relay") {
      const relay = await loadRelayCredential();
      if (!relay?.botKey) {
        ctx.log?.warn?.(
          `[fb-messenger] account ${account.accountId}: relay mode but no botKey - open the bot settings and click "Connect Facebook Page" (writes credentials/fb-messenger/relay.json)`
        );
        ctx.setStatus?.({ accountId: account.accountId, enabled: true, configured: false, reason: "no relay botKey" });
        return;
      }
      const relayUrl = (relay.url || account.relayUrl).replace(/\/+$/, "");
      const sender = createRelaySender({ url: relayUrl, botKey: relay.botKey, pageId: account.pageId });
      const dispose2 = registerDispatchContext({ account, cfg: ctx.cfg, channelRuntime, sender, log: ctx.log, setStatus: ctx.setStatus, relay: { url: relayUrl, botKey: relay.botKey } });
      const release = acquireRelayLoop({ url: relayUrl, botKey: relay.botKey, log: ctx.log });
      ctx.setStatus?.({ accountId: account.accountId, name: account.name, enabled: true, configured: true, transport: "relay" });
      ctx.log?.info?.(`[fb-messenger] account ${account.accountId} listening via relay ${relayUrl} (page ${account.pageId}${account.instagramId ? `, instagram ${account.instagramId}` : ""})`);
      await new Promise((resolve) => {
        if (ctx.abortSignal.aborted) return resolve();
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      dispose2();
      release();
      return;
    }
    let resolvedFromPersist = false;
    const persisted = await loadPageCredential(account.accountId);
    if (persisted?.pageAccessToken && await validateToken(persisted.pageAccessToken, account.graphApiVersion)) {
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
            "[fb-messenger] derived a Page token but it is NOT permanent - set FB_MESSENGER_APP_ID + FB_MESSENGER_APP_SECRET for a never-expiring token"
          );
        }
      } else {
        ctx.log?.warn?.(
          "[fb-messenger] could not resolve page from token - it may be expired/invalid. Re-enter the token (with App ID + App Secret) when editing the bot."
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
      sender: createGraphSender(account),
      log: ctx.log,
      setStatus: ctx.setStatus
    });
    ctx.setStatus?.({
      accountId: account.accountId,
      name: account.name,
      enabled: true,
      configured: true
    });
    ctx.log?.info?.(
      `[fb-messenger] account ${account.accountId} listening (page ${account.pageId || "?"}) - webhook /webhooks/messenger`
    );
    await new Promise((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    dispose();
  }
};
function parseOutboundTarget(raw) {
  let id = String(raw ?? "").trim();
  if (id.startsWith(`${CHANNEL_ID}:`)) id = id.slice(CHANNEL_ID.length + 1);
  if (id.startsWith("ig:")) return { id: id.slice(3), platform: "instagram" };
  return { id, platform: "messenger" };
}
function outboundContext(accountId) {
  return getDispatchContextForAccount(normalizeAccountId(accountId));
}
var notRunning = (accountId) => ({
  channel: CHANNEL_ID,
  ok: false,
  messageId: "",
  error: new Error(`[fb-messenger] account ${normalizeAccountId(accountId)} is not running (no sender registered)`)
});
var messengerOutbound = {
  deliveryMode: "direct",
  chunker: (text, limit) => chunkMessengerText(text, limit > 0 ? limit : void 0),
  chunkerMode: "markdown",
  textChunkLimit: 2e3,
  sendText: async ({ to, text, accountId }) => {
    const ctx = outboundContext(accountId);
    if (!ctx) return notRunning(accountId);
    const target = parseOutboundTarget(to);
    const r = await ctx.sender.sendText(target.id, text ?? "", target.platform);
    return { channel: CHANNEL_ID, ok: r.ok, messageId: r.messageId ?? "", error: r.ok ? void 0 : new Error(describeSendError(r)) };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    const ctx = outboundContext(accountId);
    if (!ctx) return notRunning(accountId);
    const target = parseOutboundTarget(to);
    let last = { ok: true };
    if (mediaUrl) {
      if (!/^https:\/\//.test(mediaUrl)) {
        return { channel: CHANNEL_ID, ok: false, messageId: "", error: new Error("[fb-messenger] Messenger only accepts media by public https URL; local files are not supported yet") };
      }
      last = await ctx.sender.sendMedia(target.id, mediaUrl, guessMediaType(mediaUrl), target.platform);
      if (!last.ok) return { channel: CHANNEL_ID, ok: false, messageId: "", error: new Error(describeSendError(last)) };
    }
    const caption = (text ?? "").trim();
    if (caption) last = await ctx.sender.sendText(target.id, caption, target.platform);
    return { channel: CHANNEL_ID, ok: last.ok, messageId: last.messageId ?? "", error: last.ok ? void 0 : new Error(describeSendError(last)) };
  }
};
var base = {
  id: CHANNEL_ID,
  meta: messengerMeta,
  capabilities: messengerCapabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: messengerConfigAdapter,
  setup: messengerSetupAdapter,
  gateway: messengerGateway,
  outbound: messengerOutbound
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

// setup-entry.ts
var setup_entry_default = defineSetupPluginEntry(messengerPlugin);
export {
  setup_entry_default as default
};
