# fb-messenger — Kênh Facebook Messenger cho OpenClaw

Thêm **Facebook Page Messenger** thành một kênh OpenClaw, song song với Telegram và Zalo.
Plugin chỉ lo nhận/gửi tin nhắn — câu trả lời do agent OpenClaw sinh ra (qua provider model bạn cấu hình, ví dụ **9Router**), giống hệt các kênh khác.

- **Inbound**: webhook công khai (`/webhooks/messenger`) nhận sự kiện Meta, xác minh chữ ký `X-Hub-Signature-256`, rồi đẩy từng tin vào agent.
- **Outbound**: trả lời stream về qua Graph API (`POST /me/messages`).
- **Tự động**: plugin tự đổi User token → Page token, tự lấy đúng Page ID, và **tự subscribe Page vào webhook** lúc khởi động.

## Yêu cầu
- OpenClaw `>= 2026.6.10`.
- **URL HTTPS công khai** trỏ về gateway (domain VPS, hoặc ngrok/cloudflared khi test).
- Một **Page** Facebook và một **App** Meta đã bật sản phẩm *Messenger*.

## Cài đặt
```bash
# Từ ClawHub (riêng tư, dưới org tuanminhhole):
openclaw plugins install clawhub:tuanminhhole/openclaw-fb-messenger
```

## Cấu hình
### 1. Meta App + Page
1. Tạo app tại <https://developers.facebook.com/apps> → thêm sản phẩm **Messenger**.
2. *Messenger → Settings*: tạo **Page Access Token** cho Page.
3. Lấy **App Secret** (*App Settings → Basic*).
4. Tự chọn một chuỗi làm **Verify Token**.

### 2. Biến môi trường
```bash
FB_MESSENGER_PAGE_ACCESS_TOKEN=EAAB...   # Page token (hoặc User token — plugin tự đổi)
FB_MESSENGER_APP_SECRET=xxxxxxxx         # App Secret (xác minh chữ ký)
FB_MESSENGER_VERIFY_TOKEN=chuoi-tu-chon  # tuỳ bạn đặt
```

### 3. openclaw.json
```jsonc
{
  "channels": {
    "fb-messenger": {
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "historyLimit": 50
    }
  }
}
```
Bí mật đọc từ env trước nên không cần ghi vào `openclaw.json`. `pageId` không bắt buộc — plugin tự suy ra từ token.

### 4. Đăng ký webhook với Meta
*Messenger → Settings → Webhooks*:
- **Callback URL**: `https://<domain-gateway>/webhooks/messenger`
- **Verify Token**: trùng `FB_MESSENGER_VERIFY_TOKEN`
- **Subscription fields**: tối thiểu `messages` (+ `messaging_postbacks` nếu dùng nút).

> Việc subscribe Page vào app được plugin **tự làm** lúc khởi động; bạn chỉ cần khai báo Callback URL + Verify Token ở trên.

## Kiểm tra
```bash
npm install
npm run check    # typecheck + check bundle
npm run build
npm test         # smoke test luồng inbound (verify + HMAC + dispatch)
```

## Phạm vi
**v1**: hội thoại 1:1 (DM) dạng text, DM policy/allowlist, xác minh chữ ký, tự chunk, tự subscribe.

**Chưa có (v2)**: nhóm/đa Page, nút quick-reply & menu, gửi chủ động, reactions, handover.

## Phát hành (nội bộ)
```bash
npm run release            # bump version + build + test + git push + clawhub publish
```
