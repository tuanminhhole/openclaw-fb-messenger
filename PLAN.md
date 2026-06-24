# Plan — `openclaw-messenger`: Facebook Messenger channel plugin cho OpenClaw

## Mục tiêu
Viết một **channel plugin chuẩn OpenClaw** thêm kênh **Facebook Messenger** vào bộ kênh hiện có (Telegram, Zalo Bot, Zalo Personal). Plugin chỉ lo nhận/gửi tin nhắn — phần AI và 9router do agent framework của OpenClaw tự xử lý. Đóng gói để **publish lên ClawHub** (`clawhub package publish <org>/openclaw-messenger`) và cài qua `openclaw plugins install clawhub:<org>/openclaw-messenger`.

## Cơ sở kỹ thuật (đã verify từ SDK openclaw@2026.6.10 + mẫu @openclaw/zalouser)
- Channel = `createChatChannelPlugin({ base, security, threading, pairing, outbound })` (`openclaw/plugin-sdk/channel-core`).
- Entry = `defineBundledChannelEntry(...)` / `defineChannelPluginEntry` (`openclaw/plugin-sdk/channel-entry-contract`).
- **Inbound webhook**: dùng `api.registerHttpRoute({ path, handler, auth })` — đăng ký endpoint cho Meta (GET verify + POST events). Đây là điểm KHÁC zalouser (zalo dùng websocket).
- **Dispatch vào agent**: trong handler/`gateway.startAccount`, gọi `ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg, dispatcherOptions:{ deliver } })` — chính nó chạy agent (→ 9router) và stream reply về callback `deliver`.
- **Outbound**: `deliver` gọi Graph API `POST https://graph.facebook.com/v21.0/me/messages` với `PAGE_ACCESS_TOKEN`.
- **Auth FB**: Page Access Token + App Secret (verify chữ ký `X-Hub-Signature-256` HMAC-SHA256) + Verify Token (cho GET challenge).
- Manifest: field `openclaw` trong `package.json` + file `openclaw.plugin.json` (channel id, config schema, channelEnvVars).

## Cấu trúc thư mục
```
openclaw-messenger/
├─ package.json            # name, type:module, peerDeps openclaw, field "openclaw"
├─ openclaw.plugin.json    # manifest: id "messenger", channels, configSchema, channelEnvVars
├─ tsconfig.json
├─ tsup.config.ts          # bundle TS -> dist ESM (giữ peer "openclaw/*" external)
├─ README.md               # hướng dẫn tạo FB App, webhook, env
├─ .gitignore
├─ index.ts                # defineBundledChannelEntry -> registerFull(registerChannel + registerHttpRoute)
├─ setup-entry.ts          # setup loader nhẹ
└─ src/
   ├─ channel.ts           # createChatChannelPlugin(...) — base/security/threading/outbound
   ├─ config.ts            # resolve account, đọc PAGE_ACCESS_TOKEN/APP_SECRET/VERIFY_TOKEN
   ├─ webhook.ts           # GET verify (hub.challenge) + POST: verify HMAC -> parse messaging[] -> dispatch
   ├─ graph-api.ts         # gọi Graph API: sendText, sendSenderAction(typing), getUserProfile
   ├─ inbound.ts           # map sự kiện Messenger -> buildContext -> dispatchReply -> deliver
   ├─ outbound.ts          # adapter gửi text/media (chunk theo giới hạn 2000 ký tự FB)
   └─ types.ts             # kiểu sự kiện webhook Messenger
```

## Các bước triển khai
1. **Scaffold** package.json / manifest / tsconfig / tsup / .gitignore (cấu hình build).
2. **config.ts** — schema 1 account: `pageId`, `pageAccessToken` (env `MESSENGER_PAGE_ACCESS_TOKEN`), `appSecret` (env `MESSENGER_APP_SECRET`), `verifyToken` (env `MESSENGER_VERIFY_TOKEN`), `dmPolicy`, `allowFrom`, `historyLimit`.
3. **graph-api.ts** — `sendMessengerText(to, text, token)`, `sendSenderAction(to,'typing_on',token)`, `getUserProfile(psid, token)`. Tự chunk text > 2000 ký tự.
4. **webhook.ts** — `GET /webhooks/messenger`: trả `hub.challenge` nếu `hub.verify_token` khớp. `POST`: verify `X-Hub-Signature-256` bằng appSecret; với mỗi `entry[].messaging[]` (chỉ `message.text`, bỏ echo/`is_echo`) → đẩy vào inbound.
5. **inbound.ts** — build `ctx` (channel `messenger`, sender PSID, conversation direct) → `dispatchReplyWithBufferedBlockDispatcher` với `deliver` = Graph API send. Áp dmPolicy/allowFrom/pairing như zalouser.
6. **channel.ts** — ráp `createChatChannelPlugin`: base(config/setup/directory self=page), security(dm), threading('off'), outbound(send text/media). Không cần auth QR.
7. **index.ts** — `registerFull(api)`: `api.registerChannel({plugin})` + `api.registerHttpRoute({ path:'/webhooks/messenger', auth:'public', handler })`.
8. **Build + typecheck**: `npm i` (devDep openclaw để có types) → `npm run build` (tsup) → `tsc --noEmit`.
9. **README** — hướng dẫn: tạo Meta App → Messenger product → cấu hình webhook URL `https://<gateway-public>/webhooks/messenger` + verify token → subscribe `messages` → lấy Page Access Token → set env.
10. **(Tùy chọn) nối vào installer** `openclaw-setup`: thêm entry `facebook` vào `CHANNELS`, `buildChannelConfig`, và `ensure_messenger()` trong docker-gen. Làm sau khi plugin chạy được.

## Quyết định / mặc định
- Package name: `openclaw-messenger` (unscoped; đổi scope khi publish nếu cần).
- Channel id: `messenger`. Aliases: `fb`, `messenger`.
- Graph API version: `v21.0`.
- Build tool: `tsup` (ESM, external `openclaw/*`).
- Phạm vi v1: **DM text only** (không group — Messenger không có group như Zalo). Media (ảnh) đưa vào nhưng tối thiểu.

## Ngoài phạm vi v1
- Group chat, reactions, postback buttons/persistent menu, handover protocol, multi-page (nhiều account) — để v2.

## Điểm chặn / lưu ý
- Webhook cần **HTTPS public** trỏ về gateway (VPS hoặc ngrok) — giống yêu cầu Zalo Bot OA.
- Token test hiện tại là short-lived; production cần Page Access Token dài hạn (System User token).
- Build/test cần node (đã có qua nvm). Chạy thật cần gateway OpenClaw.
