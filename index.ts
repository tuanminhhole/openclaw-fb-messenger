import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { messengerPlugin } from "./src/channel.js";
import { handleMessengerWebhook, WEBHOOK_PATH } from "./src/webhook.js";
import { fanpageToolFactory, fanpageTools } from "./src/tools.js";

/**
 * Full channel entry. `defineChannelPluginEntry` registers the `fb-messenger`
 * channel capability; `registerFull` additionally mounts the public Meta
 * webhook on the gateway HTTP surface (`auth: "plugin"` - the plugin verifies
 * the X-Hub-Signature-256 itself, so the gateway must not gate it).
 */
export default defineChannelPluginEntry({
  id: "fb-messenger",
  name: "Facebook Messenger",
  description: "Facebook Page Messenger via webhook + Graph API (AI handled by the OpenClaw agent).",
  plugin: messengerPlugin,
  registerFull(api) {
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      handler: handleMessengerWebhook,
    });
    // Tool Fanpage (dang bai, Reels, chuyen cho nguoi) - chi chay voi Trang ket noi qua MonkeyTech Connect.
    // Dang qua factory: dang bai/Reels chi hien voi chu bot (xem isOwnerContext trong src/tools.ts).
    (api as { registerTool: (t: unknown, o?: { names?: string[] }) => void }).registerTool(fanpageToolFactory, {
      names: fanpageTools.map((t) => t.name),
    });
  },
});
