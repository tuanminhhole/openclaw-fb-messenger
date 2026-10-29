import { CHANNEL_ID, isSenderAllowed } from "./config.js";
import type { MessengerDispatchContext } from "./registry.js";
import { pageSettings, replyComment } from "./connect-api.js";
import type { MessengerPlatform } from "./sender.js";
import type { MessengerMessagingEvent, OutboundReplyPayload } from "./types.js";

/** Nho mid da xu ly: Meta gui lai cung tin khi webhook cham, Connect cung co the phat lai sau restart. */
const SEEN_LIMIT = 5000;
const seenMids = new Set<string>();
export function rememberMid(mid: string): boolean {
  if (seenMids.has(mid)) return false;
  seenMids.add(mid);
  if (seenMids.size > SEEN_LIMIT) {
    const first = seenMids.values().next().value;
    if (first !== undefined) seenMids.delete(first);
  }
  return true;
}
/** Chi de test. */
export function resetSeenMids(): void {
  seenMids.clear();
}

const ATTACHMENT_LABEL: Record<string, string> = {
  image: "Ảnh", video: "Video", audio: "Âm thanh", file: "Tệp", location: "Vị trí", fallback: "Liên kết", template: "Mẫu", reel: "Reel", story_mention: "Nhắc trong story", ig_reel: "Reel",
};

/**
 * Chu nguoi dung gui (message, quick reply, postback) cong them dong mo ta tung attachment co URL,
 * de agent biet khach vua gui anh/tep gi. Chatwoot: `share`/`post` la link web (khong tai), sticker
 * trung URL voi image thi bo, `template`/`unsupported_type`/`ephemeral` bo qua.
 */
export function extractBody(event: MessengerMessagingEvent): string | undefined {
  if (event.message?.is_echo) return undefined; // tin do chinh Trang gui
  if (event.message?.is_deleted) return undefined; // Instagram unsend
  const parts: string[] = [];
  const text = event.message?.text?.trim();
  if (text) parts.push(text);
  else {
    const qr = event.message?.quick_reply?.payload?.trim();
    if (qr) parts.push(qr);
  }
  const seenUrls = new Set<string>();
  for (const a of event.message?.attachments ?? []) {
    const type = (a.type ?? "").toLowerCase();
    if (!type || ["template", "unsupported_type", "ephemeral"].includes(type)) continue;
    const url = a.payload?.url?.trim();
    if (url && seenUrls.has(url)) continue; // sticker + image cung URL
    if (url) seenUrls.add(url);
    const label = ATTACHMENT_LABEL[type] ?? type;
    parts.push(url ? `[${label}] ${url}` : `[${label}]`);
  }
  if (!parts.length) {
    const pb = event.postback?.payload?.trim() || event.postback?.title?.trim();
    if (pb) parts.push(pb);
  }
  return parts.length ? parts.join("\n") : undefined;
}

export interface DispatchOptions {
  platform?: MessengerPlatform;
}

/**
 * Handle one inbound Messenger/Instagram event: dedupe, enforce DM policy, build the inbound
 * context, and hand it to the agent runtime which streams the reply back through `deliver`
 * -> ctx.sender (Graph truc tiep hoac Connect goi ho).
 */
export async function dispatchMessengerEvent(
  ctx: MessengerDispatchContext,
  event: MessengerMessagingEvent,
  options: DispatchOptions = {},
): Promise<void> {
  const { account, cfg, channelRuntime, sender, log } = ctx;
  const platform: MessengerPlatform = options.platform ?? "messenger";
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

  // Reaction xac nhan da nhan (giong ackReaction cua Zalo): tha ngay, truoc khi model tra loi.
  if (account.ackReaction && mid) {
    void sender.react(senderId, mid, account.ackReaction, platform).catch(() => {});
  }

  // Best-effort: mark seen + typing while the agent thinks. Messenger drops the typing indicator
  // after ~20 s on its own, and a model turn here is 15 to 50 s, so the customer saw nothing and
  // walked away (measured 26/10/2026). Re-arm it every 10 s until the reply is delivered.
  void sender.senderAction(senderId, "mark_seen", platform).catch(() => {});
  void sender.senderAction(senderId, "typing_on", platform).catch(() => {});
  const typingTimer = setInterval(() => { void sender.senderAction(senderId, "typing_on", platform).catch(() => {}); }, TYPING_KEEPALIVE_MS);

  const profile = await sender.getProfile(senderId, platform).catch(() => null);
  const senderName = profile?.name;
  const messageId = mid || `${event.timestamp ?? Date.now()}`;
  const label = `${senderName || senderId}${platform === "instagram" ? " (Instagram)" : ""}`;

  // Resolve the agent route + session for this peer (gives agentId + sessionKey).
  // Instagram va Messenger la hai nguoi khac nhau (IGSID khac PSID) nen peer id tach tien to.
  const peerId = platform === "instagram" ? `ig:${senderId}` : senderId;
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: peerId },
  });
  const cfgSession = (cfg as { session?: { store?: unknown } }).session;
  const storePath = channelRuntime.session.resolveStorePath(cfgSession?.store, {
    agentId: route.agentId,
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
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: `${CHANNEL_ID}:${peerId}`,
      originatingTo: `${CHANNEL_ID}:${peerId}`,
    },
    message: {
      body: text,
      bodyForAgent: text,
      rawBody: text,
      commandBody: text,
    },
  });

  const deliver = async (payload: OutboundReplyPayload): Promise<unknown> => {
    // A model/provider failure comes back through the same channel as a normal reply, as text
    // like "⚠️ Authentication failed (provider returned HTTP 401)…". That is for the operator's
    // log, never for the customer: it leaks internals and reads like the shop is broken.
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
      dispatchReplyWithBufferedBlockDispatcher:
        channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
    });
  } catch (err) {
    log?.error?.(`[fb-messenger] dispatch failed for ${senderId}: ${String(err)}`);
  } finally {
    clearInterval(typingTimer);
    void sender.senderAction(senderId, "typing_off", platform).catch(() => {});
  }
}

export const TYPING_KEEPALIVE_MS = 10_000;

/**
 * OpenClaw surfaces run failures as a reply whose text starts with "⚠️" and names the provider,
 * an HTTP status, a key or a quota. Those never go to the customer.
 */
export function isSystemErrorReply(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t.startsWith("⚠️")) return false;
  return /HTTP \d{3}|API key|provider|Authentication|billing|rate limit|quota|temporar|request failed|returned a|9router|model/i.test(t);
}

export function guessMediaType(url: string): "image" | "video" | "audio" | "file" {
  const ext = (url.split("?")[0] ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "ogg", "aac"].includes(ext)) return "audio";
  return ext ? "file" : "image";
}

/** Loi gui doc duoc: ma Graph quen thuoc dich sang loi nguoi van hanh hieu. */
export function describeSendError(r: { error?: string; code?: number | null; subcode?: number | null }): string {
  if (r.code === 409) return `page disconnected from Connect - owner must connect again (${r.error})`;
  if (r.code === 10 && r.subcode === 2018278) return `outside the 24h messaging window (${r.error})`;
  if (r.code === 190) return `page token invalid/expired (${r.error})`;
  if (r.code === 613 || r.code === 4) return `rate limited by Meta (${r.error})`;
  if (r.code === 551) return `recipient unavailable or blocked the Page (${r.error})`;
  return r.error ?? "unknown error";
}

/** Khach vua nhan tin gan nhat theo Trang: tool fanpage_handover dung khi agent khong truyen customerId. */
const lastCustomer = new Map<string, { id: string; platform: MessengerPlatform }>();
export function lastCustomerOf(pageId: string): { id: string; platform: MessengerPlatform } | undefined {
  return lastCustomer.get(pageId);
}

export interface CommentEvent {
  pageId: string;
  senderId: string | null;
  mid: string | null;
  text: string | null;
  payload: { comment_id?: string; post_id?: string; parent_id?: string; from?: { id?: string; name?: string }; permalink?: string | null } | null;
}

/**
 * Binh luan moi tren bai cua Trang (Connect chi chuyen khi goi co tu dong tra loi binh luan).
 * Moi nguoi binh luan mot phien rieng (peer `cmt:<id>`), tach khoi phien Messenger cua cung nguoi.
 * Cau tra loi dang cong khai duoi binh luan; neu Trang bat "nhan rieng", bot nhan rieng noi dung
 * va chi de lai mot dong cong khai lich su.
 */
export async function dispatchCommentEvent(ctx: MessengerDispatchContext, ev: CommentEvent): Promise<void> {
  const { account, cfg, channelRuntime, log } = ctx;
  const relay = ctx.relay;
  const commentId = ev.payload?.comment_id || ev.mid || "";
  const fromId = ev.payload?.from?.id || ev.senderId || "";
  const text = (ev.text || "").trim();
  if (!relay || !commentId || !fromId || !text) return;
  if (fromId === account.pageId) return; // binh luan cua chinh Trang
  if (!rememberMid(`${account.pageId}:${commentId}`)) return;
  if (!isSenderAllowed(account, fromId)) return;

  const settings = await pageSettings(relay, account.pageId).catch(() => ({ commentReply: true, privateReply: false }));
  if (!settings.commentReply) return;
  const name = ev.payload?.from?.name || fromId;
  const peerId = `cmt:${fromId}`;
  const body = [
    `[Bình luận công khai trên bài viết của Trang${ev.payload?.permalink ? ` (${ev.payload.permalink})` : ""}]`,
    `${name}: ${text}`,
    "",
    settings.privateReply
      ? "Trả lời này sẽ được gửi riêng qua Messenger cho người bình luận. Trả lời đầy đủ như đang nhắn tin riêng."
      : "Trả lời này sẽ hiện CÔNG KHAI dưới bình luận. Viết ngắn gọn, lịch sự; không đưa số điện thoại, địa chỉ hay giá riêng của khách; nếu cần tư vấn chi tiết thì mời khách nhắn tin cho Trang.",
  ].join("\n");

  const route = channelRuntime.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: { kind: "direct", id: peerId } });
  const cfgSession = (cfg as { session?: { store?: unknown } }).session;
  const storePath = channelRuntime.session.resolveStorePath(cfgSession?.store, { agentId: route.agentId });
  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    messageId: commentId,
    timestamp: Date.now(),
    from: `${CHANNEL_ID}:${peerId}`,
    sender: { id: peerId, name },
    conversation: { kind: "direct", id: peerId, label: `${name} (bình luận)` },
    route: { agentId: route.agentId, accountId: route.accountId ?? account.accountId, routeSessionKey: route.sessionKey },
    reply: { to: `${CHANNEL_ID}:${peerId}`, originatingTo: `${CHANNEL_ID}:${peerId}` },
    message: { body, bodyForAgent: body, rawBody: text, commandBody: text },
  });

  let answered = false;
  const deliver = async (payload: OutboundReplyPayload): Promise<unknown> => {
    if (isSystemErrorReply(payload.text)) {
      log?.error?.(`[fb-messenger] model/provider error on comment ${commentId} (not posted): ${String(payload.text).slice(0, 200)}`);
      return { ok: false, error: "system error suppressed" };
    }
    const reply = payload.text?.trim();
    if (!reply) return { ok: true };
    if (settings.privateReply && !answered) {
      const priv = await replyComment(relay, account.pageId, commentId, reply, true);
      if (!priv.ok) log?.warn?.(`[fb-messenger] private reply to comment ${commentId} failed: ${priv.error}`);
      const pub = await replyComment(relay, account.pageId, commentId, priv.ok ? "Dạ shop đã nhắn riêng cho bạn, bạn xem tin nhắn giúp shop nhé." : reply);
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
      delivery: { deliver },
    });
  } catch (err) {
    log?.error?.(`[fb-messenger] comment dispatch failed for ${commentId}: ${String(err)}`);
  }
}
