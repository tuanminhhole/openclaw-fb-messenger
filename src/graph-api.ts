import { DEFAULT_GRAPH_API_VERSION, MESSENGER_TEXT_LIMIT } from "./config.js";

const GRAPH_HOST = "https://graph.facebook.com";

export interface GraphSendResult {
  ok: boolean;
  messageId?: string;
  recipientId?: string;
  error?: string;
}

interface GraphCallOptions {
  pageAccessToken: string;
  graphApiVersion?: string;
}

function graphUrl(path: string, version: string, token: string): string {
  const v = version || DEFAULT_GRAPH_API_VERSION;
  const sep = path.includes("?") ? "&" : "?";
  return `${GRAPH_HOST}/${v}${path}${sep}access_token=${encodeURIComponent(token)}`;
}

/** Split a long message into Messenger-sized chunks (2000 chars), on word boundaries when possible. */
export function chunkMessengerText(text: string, limit = MESSENGER_TEXT_LIMIT): string[] {
  const trimmed = text ?? "";
  if (trimmed.length <= limit) return trimmed.length ? [trimmed] : [];
  const chunks: string[] = [];
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

async function postSendApi(
  body: Record<string, unknown>,
  opts: GraphCallOptions,
): Promise<GraphSendResult> {
  const url = graphUrl("/me/messages", opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, opts.pageAccessToken);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    message_id?: string;
    recipient_id?: string;
    error?: { message?: string };
  };
  if (!res.ok || json.error) {
    return { ok: false, error: json.error?.message || `Graph API HTTP ${res.status}` };
  }
  return { ok: true, messageId: json.message_id, recipientId: json.recipient_id };
}

/** Send a text message, chunking automatically. Returns the last chunk's result. */
export async function sendMessengerText(
  to: string,
  text: string,
  opts: GraphCallOptions,
): Promise<GraphSendResult> {
  const chunks = chunkMessengerText(text);
  if (chunks.length === 0) return { ok: true };
  let last: GraphSendResult = { ok: true };
  for (const chunk of chunks) {
    last = await postSendApi(
      {
        messaging_type: "RESPONSE",
        recipient: { id: to },
        message: { text: chunk },
      },
      opts,
    );
    if (!last.ok) return last;
  }
  return last;
}

/** Send a media attachment by URL (image/file/video/audio). */
export async function sendMessengerMedia(
  to: string,
  mediaUrl: string,
  opts: GraphCallOptions & { mediaType?: "image" | "video" | "audio" | "file" },
): Promise<GraphSendResult> {
  return postSendApi(
    {
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message: {
        attachment: {
          type: opts.mediaType ?? "image",
          payload: { url: mediaUrl, is_reusable: true },
        },
      },
    },
    opts,
  );
}

/** Sender action: typing_on | typing_off | mark_seen. Best-effort. */
export async function sendSenderAction(
  to: string,
  action: "typing_on" | "typing_off" | "mark_seen",
  opts: GraphCallOptions,
): Promise<GraphSendResult> {
  return postSendApi({ recipient: { id: to }, sender_action: action }, opts);
}

/**
 * Resolve the effective Page context from whatever token the user supplied.
 *
 * Users frequently paste a *User* access token instead of a *Page* token, or
 * mistype the Page ID. This normalizes both: if the token can list pages
 * (`/me/accounts`), we pick the configured page (or the first) and use ITS
 * page-scoped token + id. Otherwise we assume it is already a page token and
 * read the page id from `/me`.
 */
export async function resolvePageContext(
  token: string,
  opts: { configuredPageId?: string; graphApiVersion?: string },
): Promise<{ pageId: string; pageAccessToken: string } | null> {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  try {
    const acctRes = await fetch(graphUrl("/me/accounts?fields=id,access_token,name", version, token));
    const acctJson = (await acctRes.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; access_token?: string }>;
    };
    const pages = acctJson.data ?? [];
    if (pages.length > 0) {
      const match =
        (opts.configuredPageId && pages.find((p) => p.id === opts.configuredPageId)) || pages[0];
      if (match?.id && match.access_token) {
        return { pageId: match.id, pageAccessToken: match.access_token };
      }
    }
  } catch {
    /* fall through */
  }
  // Assume the supplied token is already a page token.
  try {
    const meRes = await fetch(graphUrl("/me?fields=id", version, token));
    const me = (await meRes.json().catch(() => ({}))) as { id?: string };
    if (me.id) return { pageId: me.id, pageAccessToken: token };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Subscribe the Page to this app's webhook fields (idempotent). Removes the
 * manual "Edit Page Subscriptions" step — the gateway does it on startup.
 */
export async function subscribePageToApp(
  pageId: string,
  opts: GraphCallOptions & { fields?: string },
): Promise<{ ok: boolean; error?: string }> {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const fields = opts.fields ?? "messages,messaging_postbacks";
  try {
    const url = graphUrl(`/${encodeURIComponent(pageId)}/subscribed_apps`, version, opts.pageAccessToken);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: fields }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
    if (!res.ok || json.error) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: json.success !== false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Fetch a user's public profile (name) by PSID. Returns null on failure. */
export async function getUserProfile(
  psid: string,
  opts: GraphCallOptions,
): Promise<{ id: string; name?: string } | null> {
  const url = graphUrl(
    `/${encodeURIComponent(psid)}?fields=first_name,last_name`,
    opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION,
    opts.pageAccessToken,
  );
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string; first_name?: string; last_name?: string };
    const name = [json.first_name, json.last_name].filter(Boolean).join(" ").trim();
    return { id: json.id ?? psid, name: name || undefined };
  } catch {
    return null;
  }
}
