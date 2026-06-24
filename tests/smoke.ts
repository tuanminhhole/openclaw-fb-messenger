/**
 * Runtime smoke test of the inbound path:
 *   webhook GET verify  → 200 + challenge
 *   webhook POST (valid HMAC) → dispatch → agent stub → deliver → Graph API
 * Run: npx tsup tests/smoke.ts --format esm --external openclaw -d tests/dist && node tests/dist/smoke.js
 */
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { handleMessengerWebhook } from "../src/webhook.js";
import { registerDispatchContext } from "../src/registry.js";
import { chunkMessengerText } from "../src/graph-api.js";
import { resolveMessengerAccount, isSenderAllowed } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// ---- pure-function checks ----
check("chunk: short stays single", chunkMessengerText("hi").length === 1);
check("chunk: long splits", chunkMessengerText("a".repeat(5000)).every((c) => c.length <= 2000));

const cfg = {
  channels: {
    "fb-messenger": { pageId: "PAGE1", dmPolicy: "allowlist", allowFrom: ["USER_OK"] },
  },
} as never;
const acct = resolveMessengerAccount({
  cfg,
  accountId: "default",
  env: {
    FB_MESSENGER_PAGE_ACCESS_TOKEN: "TOK",
    FB_MESSENGER_APP_SECRET: "SECRET",
    FB_MESSENGER_VERIFY_TOKEN: "VERIFY123",
  } as never,
});
check("config: token from env", acct.pageAccessToken === "TOK");
check("config: pageId from cfg", acct.pageId === "PAGE1");
check("allowlist: allowed sender", isSenderAllowed(acct, "USER_OK"));
check("allowlist: blocked sender", !isSenderAllowed(acct, "USER_NO"));

// ---- wire a fake agent runtime that drives deliver() ----
let deliveredText: string | undefined;
const fakeRuntime = {
  routing: {
    resolveAgentRoute: () => ({ agentId: "bot", accountId: "default", sessionKey: "s1" }),
  },
  session: {
    resolveStorePath: () => "/tmp/store",
    recordInboundSession: () => {},
  },
  inbound: {
    buildContext: (p: unknown) => p,
    dispatchReply: async (args: { delivery: { deliver: (p: { text?: string }) => unknown } }) => {
      await args.delivery.deliver({ text: "Xin chào! Cảm ơn bạn đã nhắn." });
    },
  },
  reply: { dispatchReplyWithBufferedBlockDispatcher: () => {} },
};
registerDispatchContext({ account: acct, cfg, channelRuntime: fakeRuntime as never, log: {} });

// ---- mock Graph API fetch ----
const graphCalls: Array<{ url: string; body: unknown }> = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { body?: string }) => {
  graphCalls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, json: async () => ({ message_id: "mid.1", recipient_id: "USER_OK" }) } as never;
};

// ---- fake req/res helpers ----
class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
  }
}
function fakeRes() {
  const res = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    end(b = "") {
      this.body = b;
    },
  };
  return res;
}

async function run() {
  // GET verify with correct token
  {
    const req = new FakeReq("GET", "/webhooks/messenger?hub.mode=subscribe&hub.verify_token=VERIFY123&hub.challenge=CH123");
    const res = fakeRes();
    await handleMessengerWebhook(req as never, res as never);
    check("GET verify: 200", res.statusCode === 200);
    check("GET verify: echoes challenge", res.body === "CH123");
  }
  // GET verify with wrong token
  {
    const req = new FakeReq("GET", "/webhooks/messenger?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=CH123");
    const res = fakeRes();
    await handleMessengerWebhook(req as never, res as never);
    check("GET verify: wrong token 403", res.statusCode === 403);
  }
  // POST event with valid signature
  {
    const payload = {
      object: "page",
      entry: [{ id: "PAGE1", messaging: [{ sender: { id: "USER_OK" }, recipient: { id: "PAGE1" }, message: { mid: "m1", text: "alo shop" } }] }],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = "sha256=" + createHmac("sha256", "SECRET").update(raw).digest("hex");
    const req = new FakeReq("POST", "/webhooks/messenger", { "x-hub-signature-256": sig });
    const res = fakeRes();
    const p = handleMessengerWebhook(req as never, res as never);
    req.emit("data", raw);
    req.emit("end");
    await p;
    check("POST: acked 200", res.statusCode === 200);
    // dispatch + deliver are async (fire-and-forget after ack) — give them a tick
    await new Promise((r) => setTimeout(r, 50));
    deliveredText = graphCalls.find((c) => (c.body as { message?: { text?: string } })?.message?.text)?.body as never;
    const sentText = graphCalls.map((c) => (c.body as { message?: { text?: string } })?.message?.text).filter(Boolean);
    check("POST: agent reply sent via Graph API", sentText.includes("Xin chào! Cảm ơn bạn đã nhắn."));
    check("POST: typing/seen actions issued", graphCalls.some((c) => (c.body as { sender_action?: string })?.sender_action));
  }
  // POST event with bad signature → no extra reply
  {
    const before = graphCalls.length;
    const payload = { object: "page", entry: [{ id: "PAGE1", messaging: [{ sender: { id: "USER_OK" }, recipient: { id: "PAGE1" }, message: { mid: "m2", text: "hai" } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = new FakeReq("POST", "/webhooks/messenger", { "x-hub-signature-256": "sha256=deadbeef" });
    const res = fakeRes();
    const p = handleMessengerWebhook(req as never, res as never);
    req.emit("data", raw);
    req.emit("end");
    await p;
    await new Promise((r) => setTimeout(r, 50));
    check("POST: bad signature dropped (no agent reply)", graphCalls.length === before);
  }

  console.log(failures === 0 ? "\nALL_SMOKE_PASS" : `\nSMOKE_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
void deliveredText;
run();
