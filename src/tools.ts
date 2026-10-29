/**
 * Tool cho agent tren kenh Fanpage (chi transport relay qua MonkeyTech Connect):
 *   fanpage_post     dang bai (chu, link hoac anh) len Trang
 *   fanpage_reel     dang Reels tu URL video cong khai
 *   fanpage_handover chuyen khach dang nhan tin cho nguoi that (bot im voi khach do vai gio)
 * Goi Free tra 402: tool tra loi ro cho agent de bao chu Trang link nang cap, khong nem loi.
 */
import { Type } from "@sinclair/typebox";
import { handover, publishPost, publishReel, type ConnectResult } from "./connect-api.js";
import { lastCustomerOf } from "./inbound.js";
import { listDispatchContexts, type MessengerDispatchContext } from "./registry.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
const out = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data });

function pickPage(pageId?: string): { ctx?: MessengerDispatchContext; error?: string } {
  const relayCtx = listDispatchContexts().filter((c) => c.relay);
  if (!relayCtx.length) return { error: "Không có Fanpage nào kết nối qua MonkeyTech Connect trên bot này (tính năng chỉ có ở chế độ Connect)." };
  if (pageId) {
    const c = relayCtx.find((x) => x.account.pageId === String(pageId));
    return c ? { ctx: c } : { error: `Fanpage ${pageId} không thuộc bot này. Fanpage đang có: ${relayCtx.map((x) => `${x.account.name || x.account.pageId} (${x.account.pageId})`).join(", ")}` };
  }
  if (relayCtx.length === 1) return { ctx: relayCtx[0] };
  return { error: `Bot có ${relayCtx.length} Fanpage, hãy truyền pageId: ${relayCtx.map((x) => `${x.account.name || x.account.pageId} (${x.account.pageId})`).join(", ")}` };
}

function explain(r: ConnectResult, okData: Record<string, unknown>): ToolResult {
  if (r.ok) return out({ ok: true, ...okData });
  if (r.status === 402) return out({ ok: false, needUpgrade: true, message: "Tính năng này thuộc gói Pro của Fanpage. Báo chủ Trang nâng cấp tại link dưới.", upgradeUrl: r.upgradeUrl });
  return out({ ok: false, error: r.error, status: r.status });
}

export const fanpageTools = [
  {
    name: "fanpage_post",
    label: "Đăng bài Fanpage",
    description:
      "Đăng một bài lên Fanpage Facebook mà bot đang quản lý (qua MonkeyTech Connect). Dùng khi CHỦ TRANG yêu cầu đăng bài, " +
      "không tự ý đăng. Có thể kèm link hoặc một ảnh (imageUrl phải là https công khai). Trả về link bài viết.",
    parameters: Type.Object({
      message: Type.String({ description: "Nội dung bài viết." }),
      imageUrl: Type.Optional(Type.String({ description: "URL https công khai của ảnh (tuỳ chọn)." })),
      link: Type.Optional(Type.String({ description: "Link đính kèm (tuỳ chọn, không dùng cùng imageUrl)." })),
      pageId: Type.Optional(Type.String({ description: "ID Fanpage khi bot có nhiều Trang." })),
    }),
    async execute(_id: string, p: { message: string; imageUrl?: string; link?: string; pageId?: string }): Promise<ToolResult> {
      const { ctx, error } = pickPage(p.pageId);
      if (!ctx?.relay) return out({ ok: false, error });
      const r = await publishPost(ctx.relay, ctx.account.pageId, { message: p.message, imageUrl: p.imageUrl, link: p.link });
      return explain(r, { postId: r.data.postId, url: r.data.url });
    },
  },
  {
    name: "fanpage_reel",
    label: "Đăng Reels Fanpage",
    description:
      "Đăng một video Reels lên Fanpage. videoUrl phải là file mp4 https công khai, dài 3 đến 90 giây, khung dọc 9:16. " +
      "Chỉ dùng khi chủ Trang yêu cầu. Meta xử lý video vài phút trước khi hiện lên Trang.",
    parameters: Type.Object({
      videoUrl: Type.String({ description: "URL https công khai của video mp4." }),
      description: Type.Optional(Type.String({ description: "Mô tả (caption) của Reels." })),
      pageId: Type.Optional(Type.String({ description: "ID Fanpage khi bot có nhiều Trang." })),
    }),
    async execute(_id: string, p: { videoUrl: string; description?: string; pageId?: string }): Promise<ToolResult> {
      const { ctx, error } = pickPage(p.pageId);
      if (!ctx?.relay) return out({ ok: false, error });
      const r = await publishReel(ctx.relay, ctx.account.pageId, { videoUrl: p.videoUrl, description: p.description });
      return explain(r, { videoId: r.data.videoId, url: r.data.url });
    },
  },
  {
    name: "fanpage_handover",
    label: "Chuyển khách cho người",
    description:
      "Chuyển khách đang nhắn Fanpage cho nhân viên thật khi: khách đòi gặp người, khiếu nại, hỏi việc ngoài tài liệu, hoặc cần quyết định " +
      "về giá, đổi trả, công nợ. Sau khi gọi, bot im với khách này vài giờ, hội thoại hiện nhãn 'can-nguoi' trong hộp thư MonkeyTech Connect. " +
      "Trước khi gọi, nói với khách rằng nhân viên sẽ phản hồi sớm.",
    parameters: Type.Object({
      reason: Type.String({ description: "Lý do ngắn gọn cho nhân viên đọc." }),
      customerId: Type.Optional(Type.String({ description: "PSID của khách. Bỏ trống = khách vừa nhắn gần nhất." })),
      pageId: Type.Optional(Type.String({ description: "ID Fanpage khi bot có nhiều Trang." })),
    }),
    async execute(_id: string, p: { reason: string; customerId?: string; pageId?: string }): Promise<ToolResult> {
      const { ctx, error } = pickPage(p.pageId);
      if (!ctx?.relay) return out({ ok: false, error });
      const raw = p.customerId || lastCustomerOf(ctx.account.pageId)?.id;
      const recipientId = raw?.replace(/^(ig:|fb-messenger:)/, "");
      if (!recipientId) return out({ ok: false, error: "Chưa biết khách nào để chuyển: truyền customerId." });
      const r = await handover(ctx.relay, ctx.account.pageId, recipientId, p.reason);
      return explain(r, { pausedUntil: r.data.pausedUntil, customerId: recipientId });
    },
  },
];
