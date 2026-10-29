# Changelog

All notable changes to **fb-messenger** are documented here.

## [0.3.0] - 2026-10-30
### Added
- **Comment auto-replies** (relay transport, needs MonkeyTech Connect 0.5): new comments on the Page's posts reach the agent as a public-comment turn (session `cmt:<user>`), and the reply is posted under the comment. When the Page turns on "message the commenter privately", the answer goes to Messenger and a short "we messaged you" note is left under the comment. The Page's own comments are never answered.
- **Agent tools**: `fanpage_post` (text, link or image post), `fanpage_reel` (Reels from a public mp4 URL) and `fanpage_handover` (hand the customer to a human: the bot stays quiet with them for a few hours and the conversation gets the `can-nguoi` label in the Connect inbox). On the Free plan the tools return `needUpgrade` with the billing link instead of throwing.
- `quota` events from Connect (Free plan at 80% / 100% of the monthly conversations) are logged for the operator.

## [0.2.1] - 2026-10-26
### Added
- **Ack reaction** (`ackReaction`, defaults to OpenClaw's `messages.ackReaction`; the Zalo code `/-heart` maps to the heart emoji): every inbound message gets a reaction right away, like the Zalo channel. Messenger accepts any emoji, Instagram always sends "love". Works on both transports (Connect proxies `sender_action: react`).

### Fixed
- **Typing indicator kept alive.** Messenger drops `typing_on` after about 20 seconds while a model turn takes 15 to 50 seconds, so customers saw a silent Page and left (measured on a live Page, 26/10/2026). The plugin now re-sends `typing_on` every 10 seconds until the reply is delivered, on both transports.
- **Provider errors no longer reach the customer.** OpenClaw returns run failures as a reply starting with "⚠️" ("Authentication failed (HTTP 401)", "billing error", "provider internal error 503"). Four of those were sent to a real customer during the test. They are now logged for the operator and never delivered.

## [0.2.0] - 2026-10-26
### Added
- **Relay transport via MonkeyTech Connect** (`transport: "relay"`, the default when no `pageAccessToken` is set). The gateway long-polls `GET /api/events?since&wait=25` on `connect.monkeytech.vn` and replies through `POST /api/pages/:id/messages`. The bot holds only a `botKey` (`credentials/fb-messenger/relay.json` or `FB_MESSENGER_RELAY_KEY`); the Page token and the Meta App Secret never leave Connect. No public HTTPS, no Meta developer account on the customer side.
- **Instagram Direct** on the same account: events Connect tags as `instagram` are dispatched with peer id `ig:<igsid>` and answered on the Instagram platform. Outbound targets accept `ig:<igsid>`.
- **Outbound adapter** (`sendText` / `sendMedia`): the agent can now message a customer proactively (tool `message`, cron, skill delivery). Media must be a public https URL (Messenger limitation); a local path is refused with a clear error.
- **Inbound attachments**: images, video, audio, files, locations and shares are listed in the message body as `[Ảnh] <url>` lines so the agent knows what the customer sent. Stickers that duplicate an image URL and `template` / `unsupported_type` / `ephemeral` payloads are skipped (lessons from Chatwoot).
- **Dedupe by `mid`** (5,000-entry window) on both transports: Meta redelivers on slow webhooks and Connect may replay after a restart.
- Echo events (`sent`, including a human replying from the Facebook Inbox) and `read` / `delivery` / `unsent` are received but never answered. `disconnected` (owner removed the app) flips the account status and sends fail with a readable 409 message until the owner connects again.
- Relay loop: single loop per botKey shared by all accounts, cursor persisted in `credentials/fb-messenger/relay-cursor.json` (restart loses nothing, fresh install does not replay history), exponential backoff on errors, 401 logged once per minute instead of hammering.
- Graph error codes are translated for operators: 10/2018278 (outside the 24h window), 190 (token invalid), 613/4 (rate limited), 551 (blocked), 409 (page disconnected from Connect).
- Multi-Page: in relay mode `channels.fb-messenger.accounts[<pageId>]` is the account key, so one gateway can serve several Pages. Config keys `transport`, `relayUrl`, `instagramId` added to the strict channel schema.
- Smoke test extended to 50 checks (webhook + relay + outbound) and a new `npm run test:e2e` that runs the real Connect server in-process (SQLite temp, Graph mocked) end to end: Meta webhook -> Connect -> long-poll -> agent -> Connect -> Graph, Instagram, redelivery, proactive send, deauthorize.

### Changed
- Webhook transport now **requires** the App Secret: an unsigned POST is dropped instead of trusted ("dev only" skip removed).
- Default Graph API version `v24.0` (was `v21.0`).
- Log and comment text uses plain hyphens only.

### Not yet
- Separate `instagram` channel id (Instagram still routes through the `fb-messenger` channel of its Page).
- Downloading inbound media to the workspace; `standby` / handover protocol; message tags (`HUMAN_AGENT`); comments and Page posts (waiting on Meta permissions).

## [0.1.1] - 2026-07-09
### Added
- Public release: repo is now public and published to ClawHub with a Messenger logo (manifest `icon` field, served via jsDelivr).
- `setup.providers[].envVars` metadata so onboarding surfaces can inspect required env vars without loading runtime code.

### Changed
- Ship the prebuilt `dist/` in the ClawHub package so the runtime entry is present on install (no build step for end users).
- README: clearer install-from-ClawHub steps, build-from-source moved to a contributor note, added the OpenClaw ecosystem section + footer.
- `channelEnvVars` kept for backward compatibility with older OpenClaw versions (superseded by `setup.providers`).

## [0.1.0] - 2026-06-25
### Added
- Initial release: Facebook Messenger channel plugin for OpenClaw.
- Inbound via public webhook (`/webhooks/messenger`) with `X-Hub-Signature-256` verification + GET verify handshake.
- Outbound via Graph API (`/me/messages`) with auto text chunking (2000 chars).
- AI replies handled by the OpenClaw agent runtime (works with 9Router).
- DM policy / allowlist, typing + seen indicators.
- Token self-healing: accepts a User token (auto-exchanges for the Page token) or a mistyped Page ID; resolves the real Page ID at startup.
- Auto-subscribes the Page to the app webhook on startup (no manual Meta dashboard step).
