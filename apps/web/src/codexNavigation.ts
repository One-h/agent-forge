export const CODEX_THREAD_MESSAGE = "autofix:open-codex-thread";

declare global {
  interface Window {
    __AUTOFIX_CODEX_EMBED__?: boolean;
  }
}

export function openCodexThread(url: string): void {
  if (window.__AUTOFIX_CODEX_EMBED__ && window.parent !== window) {
    window.parent.postMessage({ type: CODEX_THREAD_MESSAGE, url }, "*");
    return;
  }
  window.location.href = url;
}
