/**
 * Lop gui tin: cung mot giao dien cho hai duong.
 *   graph: goi Graph API truc tiep bang Page token (transport webhook, ban 0.1).
 *   relay: nho MonkeyTech Connect goi ho (POST /api/pages/:id/messages), bot khong cam token.
 * inbound.ts (tra loi trong luot) va outbound adapter (agent nhan chu dong) deu di qua day.
 */
import { MESSENGER_TEXT_LIMIT, type ResolvedMessengerAccount } from "./config.js";
import { chunkMessengerText, getUserProfile, sendMessengerMedia, sendMessengerText, sendSenderAction, type GraphSendResult } from "./graph-api.js";

export type MessengerPlatform = "messenger" | "instagram";
export type SenderAction = "typing_on" | "typing_off" | "mark_seen";
export type MediaType = "image" | "video" | "audio" | "file";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** Ma loi Graph (190 token, 10 ngoai cua so 24h, 613 rate limit, 551 bi chan); 409 = Trang da ngat Connect. */
  code?: number | null;
  subcode?: number | null;
}

export interface MessengerSender {
  sendText(to: string, text: string, platform?: MessengerPlatform): Promise<SendResult>;
  sendMedia(to: string, url: string, type: MediaType, platform?: MessengerPlatform): Promise<SendResult>;
  senderAction(to: string, action: SenderAction, platform?: MessengerPlatform): Promise<SendResult>;
  getProfile(psid: string, platform?: MessengerPlatform): Promise<{ id: string; name?: string } | null>;
}

const fromGraph = (r: GraphSendResult): SendResult => ({ ok: r.ok, messageId: r.messageId, error: r.error });

export function createGraphSender(account: ResolvedMessengerAccount): MessengerSender {
  const opts = { pageAccessToken: account.pageAccessToken, graphApiVersion: account.graphApiVersion };
  return {
    sendText: async (to, text) => fromGraph(await sendMessengerText(to, text, opts)),
    sendMedia: async (to, url, type) => fromGraph(await sendMessengerMedia(to, url, { ...opts, mediaType: type })),
    senderAction: async (to, action) => fromGraph(await sendSenderAction(to, action, opts)),
    getProfile: (psid) => getUserProfile(psid, opts),
  };
}

export interface RelayClientOptions {
  url: string;
  botKey: string;
  pageId: string;
  fetchImpl?: typeof fetch;
}

/** Goi Connect: moi loi tra ve dang SendResult, khong nem. */
async function relayCall(opts: RelayClientOptions, path: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${opts.botKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function relayResult(status: number, json: Record<string, unknown>): SendResult {
  if (json.ok === true) {
    const sent = Array.isArray(json.sent) ? (json.sent as Array<{ messageId?: string }>) : [];
    return { ok: true, messageId: sent[sent.length - 1]?.messageId };
  }
  const err = json.error as { message?: string; code?: number | null; subcode?: number | null } | string | undefined;
  if (typeof err === "string") return { ok: false, error: err, code: status === 409 ? 409 : null };
  return { ok: false, error: err?.message || `Connect HTTP ${status}`, code: err?.code ?? (status === 409 ? 409 : null), subcode: err?.subcode ?? null };
}

export function createRelaySender(opts: RelayClientOptions): MessengerSender {
  const post = (body: Record<string, unknown>) =>
    relayCall(opts, `/api/pages/${encodeURIComponent(opts.pageId)}/messages`, { method: "POST", body: JSON.stringify(body) })
      .then(({ status, json }) => relayResult(status, json))
      .catch((e) => ({ ok: false, error: String(e), code: null } as SendResult));
  return {
    sendText: async (to, text, platform) => {
      let last: SendResult = { ok: true };
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
        const c = json.contact as { id?: string; name?: string | null } | undefined;
        return { id: c?.id ?? psid, name: c?.name || undefined };
      } catch {
        return null;
      }
    },
  };
}
