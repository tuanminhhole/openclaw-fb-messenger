/**
 * Relay transport: mot vong long-poll duy nhat cho ca gateway toi MonkeyTech Connect
 * (GET /api/events?since=<cursor>&wait=25). Su kien duoc chia ve dung account theo pageId.
 * Meta chi cho mot Webhook Callback URL moi app, con bot khach nam sau NAT: Connect nhan ho roi
 * bot keo ve. Khuon giong GET /api/events cua MonkeyPay.
 */
import { loadRelayCursor, saveRelayCursor } from "./credentials.js";
import { dispatchCommentEvent, dispatchMessengerEvent, type CommentEvent } from "./inbound.js";
import { getDispatchContextForPage, hasRegisteredAccounts } from "./registry.js";
import type { MessengerMessagingEvent } from "./types.js";

export interface RelayEvent {
  id: number;
  object: "page" | "instagram" | string;
  pageId: string | null;
  senderId: string | null;
  kind: "message" | "postback" | "sent" | "read" | "delivery" | "unsent" | "disconnected" | "token_invalid" | string;
  direction: "in" | "out";
  mid: string | null;
  text: string | null;
  receivedAt: string;
  payload: unknown;
}

export interface RelayLoopOptions {
  url: string;
  botKey: string;
  waitSec?: number;
  fetchImpl?: typeof fetch;
  log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /** Test hook: duoc goi sau moi vong (ke ca vong rong). */
  onCycle?: (events: RelayEvent[]) => void;
}

interface LoopState {
  key: string;
  abort: AbortController;
  refs: number;
  done: Promise<void>;
}

let loop: LoopState | null = null;

/**
 * Bat vong long-poll neu chua co (nhieu account dung chung mot botKey). Tra ve ham "tha":
 * account cuoi cung tha thi vong dung.
 */
export function acquireRelayLoop(opts: RelayLoopOptions): () => void {
  const key = `${opts.url}|${opts.botKey}`;
  if (loop && loop.key === key && !loop.abort.signal.aborted) {
    loop.refs += 1;
  } else {
    if (loop) loop.abort.abort();
    const abort = new AbortController();
    const state: LoopState = { key, abort, refs: 1, done: Promise.resolve() };
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

/** Chi de test: dung moi vong dang chay. */
export function stopRelayLoopForTests(): void {
  loop?.abort.abort();
  loop = null;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

async function runLoop(opts: RelayLoopOptions, signal: AbortSignal): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const wait = Math.min(25, Math.max(1, opts.waitSec ?? 25));
  const headers = { authorization: `Bearer ${opts.botKey}` };
  let cursor = await loadRelayCursor();
  let backoffMs = 2000;
  opts.log?.info?.(`[fb-messenger] relay: polling ${opts.url} (cursor ${cursor ?? "fresh"})`);

  while (!signal.aborted) {
    const since = cursor === null ? "" : `since=${cursor}&wait=${wait}`;
    let res: Response;
    try {
      res = await f(`${opts.url}/api/events${since ? `?${since}` : ""}`, { headers, signal });
    } catch (e) {
      if (signal.aborted) return;
      opts.log?.warn?.(`[fb-messenger] relay: ${String(e)} - retry in ${backoffMs / 1000}s`);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
      continue;
    }
    if (res.status === 401) {
      // botKey sai hoac da bi thu hoi: khong co gi de thu lai, nguoi dung phai Ket noi lai trong Setup UI.
      opts.log?.error?.("[fb-messenger] relay: botKey rejected by Connect (401) - open the bot settings and connect the Facebook Page again");
      await sleep(60_000, signal);
      continue;
    }
    if (!res.ok) {
      opts.log?.warn?.(`[fb-messenger] relay: HTTP ${res.status} - retry in ${backoffMs / 1000}s`);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
      continue;
    }
    backoffMs = 2000;
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; cursor?: number; events?: RelayEvent[] };
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
    if (!hasRegisteredAccounts()) await sleep(1000, signal);
  }
}

async function handleRelayEvent(ev: RelayEvent, opts: RelayLoopOptions): Promise<void> {
  if (!ev.pageId) return;
  const ctx = getDispatchContextForPage(ev.pageId);
  if (!ctx) {
    opts.log?.info?.(`[fb-messenger] relay: event for page ${ev.pageId} but no account registered for it`);
    return;
  }
  switch (ev.kind) {
    case "message":
    case "postback": {
      const event = ev.payload as MessengerMessagingEvent;
      if (!event || typeof event !== "object" || !event.sender) return;
      await dispatchMessengerEvent(ctx, event, { platform: ev.object === "instagram" ? "instagram" : "messenger" });
      return;
    }
    case "comment":
      await dispatchCommentEvent(ctx, { pageId: ev.pageId, senderId: ev.senderId, mid: ev.mid, text: ev.text, payload: (ev.payload ?? null) as CommentEvent["payload"] });
      return;
    case "quota": {
      // Connect bao goi Free da dung 80% / 100% han muc thang: ghi log cho nguoi van hanh thay.
      const p = (ev.payload ?? {}) as { level?: number; used?: number; quota?: number };
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
      // Echo: tin do Trang gui (bot nay, hop thu Connect, hay nguoi that trong Inbox Facebook). Khong tra loi.
      ctx.log?.info?.(`[fb-messenger] echo on page ${ev.pageId} to ${ev.senderId ?? "?"}${ev.text ? `: ${ev.text.slice(0, 60)}` : ""}`);
      return;
    default:
      return; // read, delivery, unsent, change...
  }
}
