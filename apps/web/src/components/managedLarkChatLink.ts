const chatAppLink = "https://applink.feishu.cn/client/chat/open";
const chatIdPattern = /^oc_[A-Za-z0-9_-]{1,196}$/;

export function managedLarkChatLink(chatId: string | null, openUrl: string | null): string | null {
  const validatedChatId = chatId && chatIdPattern.test(chatId) ? chatId : null;
  if (openUrl) {
    try {
      const upstream = new URL(openUrl);
      const ids = upstream.searchParams.getAll("openChatId");
      const openChatId = ids[0];
      if (upstream.protocol === "https:" && upstream.origin === "https://applink.feishu.cn" && upstream.pathname === "/client/chat/open"
        && !upstream.username && !upstream.password && ids.length === 1 && openChatId && chatIdPattern.test(openChatId)
        && (chatId === null || openChatId === validatedChatId)) {
        // Rebuild the URL so other upstream parameters cannot affect navigation.
        return `${chatAppLink}?openChatId=${encodeURIComponent(openChatId)}`;
      }
    } catch { /* A valid chat ID can still provide a direct link. */ }
  }
  return validatedChatId ? `${chatAppLink}?openChatId=${encodeURIComponent(validatedChatId)}` : null;
}
