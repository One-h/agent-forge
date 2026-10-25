import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Check, RefreshCw, Search, Send } from "lucide-react";
import { api, type Notification } from "../api";
import { formatTime } from "../i18n";
import { usePersistentState } from "../usePersistentState";

export function NotificationList({
  notificationPermission,
  onEnableChromeNotifications,
  onTestChromeNotification,
  onPushUnreadNotifications
}: {
  notificationPermission: NotificationPermission | "unsupported";
  onEnableChromeNotifications: () => Promise<NotificationPermission | "unsupported">;
  onTestChromeNotification: () => Promise<NotificationPermission | "unsupported">;
  onPushUnreadNotifications: (notifications: Notification[], options?: { force?: boolean }) => void;
}) {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = usePersistentState("autofix.notifications.query", "");
  const [readFilter, setReadFilter] = usePersistentState<"unread" | "all">("autofix.notifications.read", "unread");

  const load = async () => {
    const nextNotifications = await api.notifications();
    setNotifications(nextNotifications);
    onPushUnreadNotifications(nextNotifications);
  };

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, []);

  const markRead = async (id: number) => {
    await api.markNotificationRead(id);
    await load();
  };

  const pushUnread = async () => {
    const nextPermission = notificationPermission === "granted" ? notificationPermission : await onEnableChromeNotifications();
    if (nextPermission === "granted") {
      onPushUnreadNotifications(notifications, { force: true });
    }
  };

  const permissionCopy = {
    granted: "Chrome 通知已启用",
    denied: "Chrome 通知已被阻止",
    default: "尚未启用 Chrome 通知",
    unsupported: "当前浏览器不支持通知"
  }[notificationPermission];

  const openNotification = (notification: Notification) => {
    if (!notification.issue_id) {
      return;
    }
    navigate(notification.kind === "pr" ? `/pulls/${notification.issue_id}` : `/issues/${notification.issue_id}`);
  };
  const filteredNotifications = useMemo(() => notifications.filter((notification) => {
    const text = `${notification.title} ${notification.body ?? ""} ${notification.repo_owner ?? ""}/${notification.repo_name ?? ""}`.toLowerCase();
    return (readFilter === "all" || !notification.read_at) && text.includes(query.toLowerCase());
  }), [notifications, query, readFilter]);

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">收件事件</p>
          <h2>通知</h2>
          <p className="subtle">由 Gitea 同步产生的问题和 PR 通知。</p>
        </div>
        <div className="actionGroup">
          <button className="ghostButton" onClick={() => void onEnableChromeNotifications()}>
            <Bell size={16} /> 启用 Chrome 通知
          </button>
          <button className="ghostButton" onClick={() => void onTestChromeNotification()}>
            <Bell size={16} /> 测试通知
          </button>
          <button className="ghostButton" onClick={() => void pushUnread()}>
            <Send size={16} /> 推送未读
          </button>
          <button className="ghostButton" onClick={() => void load()}><RefreshCw size={16} /> 刷新</button>
        </div>
      </div>
      <div className="notice">{permissionCopy}</div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div className="toolbar">
          <label className="searchBox">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索通知..." />
          </label>
          <div className="segmentedControl" aria-label="通知筛选">
            <button className={readFilter === "unread" ? "active" : ""} onClick={() => setReadFilter("unread")}>未读</button>
            <button className={readFilter === "all" ? "active" : ""} onClick={() => setReadFilter("all")}>全部</button>
          </div>
          <span className="toolbarCount">{filteredNotifications.length} 条</span>
        </div>
        <div className="notificationList">
          {filteredNotifications.map((notification) => (
            <div className={`notificationItem ${notification.read_at ? "read" : "unread"}`} key={notification.id}>
              <div className="notificationIcon"><Bell size={16} /></div>
              <button className="notificationBody" onClick={() => openNotification(notification)}>
                <strong>{notification.title}</strong>
                <span>{notification.body || "-"}</span>
                <small>{formatTime(notification.created_at)}</small>
              </button>
              {!notification.read_at && (
                <button className="iconButton" title="标记已读" onClick={() => void markRead(notification.id)}>
                  <Check size={16} />
                </button>
              )}
            </div>
          ))}
          {filteredNotifications.length === 0 && <div className="emptyState">没有符合当前条件的通知。</div>}
        </div>
      </div>
    </section>
  );
}
