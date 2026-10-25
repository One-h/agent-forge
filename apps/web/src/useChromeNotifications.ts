import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Notification as AutofixNotification } from "./api";

const storageKey = "autofix.notifiedNotificationIds";

function hasBrowserNotifications(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function readNotifiedIds(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

function writeNotifiedIds(ids: Set<number>): void {
  localStorage.setItem(storageKey, JSON.stringify([...ids].slice(-500)));
}

function notificationPath(notification: AutofixNotification): string {
  if (!notification.issue_id) {
    return "/notifications";
  }
  return notification.kind === "pr" ? `/pulls/${notification.issue_id}` : `/issues/${notification.issue_id}`;
}

export function useChromeNotifications(onOpenNotification: (path: string) => void) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    hasBrowserNotifications() ? Notification.permission : "unsupported"
  );
  const notifiedIdsRef = useRef<Set<number>>(readNotifiedIds());

  const enabled = permission === "granted";

  const requestPermission = useCallback(async () => {
    if (!hasBrowserNotifications()) {
      setPermission("unsupported");
      return "unsupported";
    }
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
    return nextPermission;
  }, []);

  const pushNotification = useCallback((notification: AutofixNotification, options?: { force?: boolean }) => {
    if (!hasBrowserNotifications() || Notification.permission !== "granted") {
      return;
    }
    if (notification.read_at || (!options?.force && notifiedIdsRef.current.has(notification.id))) {
      return;
    }

    const chromeNotification = new Notification(notification.title, {
      body: notification.body ?? undefined,
      tag: `autofix-${notification.id}`
    });
    chromeNotification.onclick = () => {
      chromeNotification.close();
      window.focus();
      onOpenNotification(notificationPath(notification));
    };

    notifiedIdsRef.current.add(notification.id);
    writeNotifiedIds(notifiedIdsRef.current);
  }, [onOpenNotification]);

  const pushUnreadNotifications = useCallback(
    (notifications: AutofixNotification[], options?: { force?: boolean }) => {
      notifications.filter((notification) => !notification.read_at).forEach((notification) => pushNotification(notification, options));
    },
    [pushNotification]
  );

  const sendTestNotification = useCallback(async () => {
    if (!hasBrowserNotifications()) {
      setPermission("unsupported");
      return "unsupported";
    }

    let nextPermission: NotificationPermission = Notification.permission;
    if (nextPermission !== "granted") {
      nextPermission = await Notification.requestPermission();
    }
    setPermission(nextPermission);
    if (nextPermission !== "granted") {
      return nextPermission;
    }

    const chromeNotification = new Notification("Agent Forge 测试通知", {
      body: "Chrome 通知工作正常。",
      tag: "autofix-test-notification"
    });
    chromeNotification.onclick = () => {
      chromeNotification.close();
      window.focus();
      onOpenNotification("/notifications");
    };
    return nextPermission;
  }, [onOpenNotification]);

  const poll = useCallback(async () => {
    if (!hasBrowserNotifications() || Notification.permission !== "granted") {
      return;
    }
    const notifications = await api.notifications();
    pushUnreadNotifications(notifications);
  }, [pushUnreadNotifications]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled, poll]);

  return useMemo(
    () => ({ permission, enabled, requestPermission, pushNotification, pushUnreadNotifications, sendTestNotification }),
    [enabled, permission, pushNotification, pushUnreadNotifications, requestPermission, sendTestNotification]
  );
}
