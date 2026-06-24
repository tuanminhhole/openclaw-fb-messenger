import { CHANNEL_ID, isSenderAllowed } from "./config.js";
import { getUserProfile, sendMessengerText, sendMessengerMedia, sendSenderAction } from "./graph-api.js";
import type { MessengerDispatchContext } from "./registry.js";
import type { MessengerMessagingEvent, OutboundReplyPayload } from "./types.js";

/** Pull the user-visible text out of a Messenger event (message or postback). */
function extractText(event: MessengerMessagingEvent): string | undefined {
  if (event.message?.is_echo) return undefined; // ignore our own echoes
  const fromMessage = event.message?.text?.trim();
  if (fromMessage) return fromMessage;
  const fromQuickReply = event.message?.quick_reply?.payload?.trim();
  if (fromQuickReply) return fromQuickReply;
  const fromPostback = event.postback?.payload?.trim() || event.postback?.title?.trim();
  return fromPostback || undefined;
}

/**
 * Handle one inbound Messenger event: enforce DM policy, build the inbound
 * context, and hand it to the agent runtime which calls 9router and streams the
 * reply back through `deliver` → Graph API.
 */
export async function dispatchMessengerEvent(
  ctx: MessengerDispatchContext,
  event: MessengerMessagingEvent,
): Promise<void> {
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
    graphApiVersion: account.graphApiVersion,
  };

  // Best-effort: mark seen + typing while the agent thinks.
  void sendSenderAction(senderId, "mark_seen", sendOpts).catch(() => {});
  void sendSenderAction(senderId, "typing_on", sendOpts).catch(() => {});

  const profile = await getUserProfile(senderId, sendOpts).catch(() => null);
  const senderName = profile?.name;
  const messageId = event.message?.mid || event.postback?.mid || `${event.timestamp ?? ""}`;

  // Resolve the agent route + session for this peer (gives agentId + sessionKey).
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: senderId },
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
    from: `${CHANNEL_ID}:${senderId}`,
    sender: { id: senderId, name: senderName },
    conversation: { kind: "direct", id: senderId, label: senderName || senderId },
    route: {
      agentId: route.agentId,
      accountId: route.accountId ?? account.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: `${CHANNEL_ID}:${senderId}`,
      originatingTo: `${CHANNEL_ID}:${senderId}`,
    },
    message: {
      body: text,
      bodyForAgent: text,
      rawBody: text,
      commandBody: text,
    },
  });

  const deliver = async (payload: OutboundReplyPayload): Promise<unknown> => {
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
      dispatchReplyWithBufferedBlockDispatcher:
        channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
    });
  } catch (err) {
    log?.error?.(`[fb-messenger] dispatch failed for ${senderId}: ${String(err)}`);
  } finally {
    void sendSenderAction(senderId, "typing_off", sendOpts).catch(() => {});
  }
}
