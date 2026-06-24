# Changelog

All notable changes to **fb-messenger** are documented here.

## [0.1.0] - 2026-06-25
### Added
- Initial release: Facebook Messenger channel plugin for OpenClaw.
- Inbound via public webhook (`/webhooks/messenger`) with `X-Hub-Signature-256` verification + GET verify handshake.
- Outbound via Graph API (`/me/messages`) with auto text chunking (2000 chars).
- AI replies handled by the OpenClaw agent runtime (works with 9Router).
- DM policy / allowlist, typing + seen indicators.
- Token self-healing: accepts a User token (auto-exchanges for the Page token) or a mistyped Page ID; resolves the real Page ID at startup.
- Auto-subscribes the Page to the app webhook on startup (no manual Meta dashboard step).
