/**
 * Goi them API cua MonkeyTech Connect ngoai gui tin: tra loi binh luan, dang bai, Reels, chuyen cho nguoi,
 * cai dat Trang. Chi co o transport relay (Connect giu token Trang). Moi loi tra ve dang { ok:false, ... }.
 * 402 = goi Free, kem billingUrl de bot noi cho chu Trang biet cho nang cap.
 */
export interface RelayAuth {
  url: string;
  botKey: string;
}

export interface ConnectResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
  error?: string;
  upgradeUrl?: string;
}

export async function connectCall(relay: RelayAuth, path: string, init: { method?: string; body?: unknown } = {}, fetchImpl: typeof fetch = fetch): Promise<ConnectResult> {
  try {
    const res = await fetchImpl(`${relay.url.replace(/\/+$/, "")}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${relay.botKey}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && data.ok !== false) return { ok: true, status: res.status, data };
    const err = data.error as { message?: string } | string | undefined;
    return {
      ok: false,
      status: res.status,
      data,
      error: typeof err === "string" ? err : err?.message || `Connect HTTP ${res.status}`,
      upgradeUrl: res.status === 402 ? String(data.billingUrl || "") : undefined,
    };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: String(e) };
  }
}

const page = (id: string) => `/api/pages/${encodeURIComponent(id)}`;

export const replyComment = (r: RelayAuth, pageId: string, commentId: string, message: string, isPrivate = false, f?: typeof fetch) =>
  connectCall(r, `${page(pageId)}/comments/${encodeURIComponent(commentId)}/replies`, { body: { message, private: isPrivate } }, f);

export const publishPost = (r: RelayAuth, pageId: string, body: { message?: string; link?: string; imageUrl?: string }, f?: typeof fetch) =>
  connectCall(r, `${page(pageId)}/posts`, { body }, f);

export const publishReel = (r: RelayAuth, pageId: string, body: { videoUrl: string; description?: string }, f?: typeof fetch) =>
  connectCall(r, `${page(pageId)}/reels`, { body }, f);

export const handover = (r: RelayAuth, pageId: string, recipientId: string, reason?: string, f?: typeof fetch) =>
  connectCall(r, `${page(pageId)}/handover`, { body: { recipientId, reason } }, f);

/** Cai dat Trang (tra loi binh luan, nhan rieng cho nguoi binh luan), cache 60 giay. */
const settingsCache = new Map<string, { at: number; value: { commentReply: boolean; privateReply: boolean } }>();
export async function pageSettings(r: RelayAuth, pageId: string, f?: typeof fetch): Promise<{ commentReply: boolean; privateReply: boolean }> {
  const hit = settingsCache.get(pageId);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const res = await connectCall(r, `${page(pageId)}/settings`, {}, f);
  const s = (res.data.settings ?? {}) as { commentReply?: boolean; privateReply?: boolean };
  const value = { commentReply: s.commentReply !== false, privateReply: s.privateReply === true };
  settingsCache.set(pageId, { at: Date.now(), value });
  return value;
}
export function resetSettingsCacheForTests(): void {
  settingsCache.clear();
}
