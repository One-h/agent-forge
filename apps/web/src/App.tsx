import { GroupPrivacyPage } from "./pages/GroupPrivacy";
import { AgentMessagingPage } from "./pages/AgentMessaging";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, Bell, BriefcaseBusiness, ChevronRight, CircleAlert, Command, Gauge, GitPullRequestArrow, Images, Inbox, ListTodo, Mail, MessageSquareText, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Route as RouteIcon, Settings2, Shield, ShieldCheck, Sun, Users, WandSparkles, Workflow } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { IssueDetailDrawer } from "./components/IssueDetailDrawer";
import { Dashboard } from "./pages/Dashboard";
import { IssueList } from "./pages/IssueList";
import { LarkMessageList } from "./pages/LarkMessageList";
import { LarkManagedChatsPage } from "./pages/LarkManagedChats";
import { LarkTasksPage } from "./pages/LarkTasks";
import { PersonalInboxPage } from "./pages/PersonalInbox";
import { NotificationList } from "./pages/NotificationList";
import { PullRequestList } from "./pages/PullRequestList";
import { RunList } from "./pages/RunList";
import { SettingsPage } from "./pages/Settings";
import { StickerLibrary } from "./pages/StickerLibrary";
import { TodoList } from "./pages/TodoList";
import { ApprovalHistory } from "./pages/ApprovalHistory";
import { useChromeNotifications } from "./useChromeNotifications";
import { api, type ForgeRuntimeStatus } from "./api";

export function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("autofix.sidebarCollapsed") === "true");
  const navigationRef = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("autofix.theme") === "dark" ? "dark" : "light");
  const [runtimeStatus, setRuntimeStatus] = useState<ForgeRuntimeStatus | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const chromeNotifications = useChromeNotifications(navigate);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 980px)");
    const revealActive = () => {
      const navigation = navigationRef.current;
      const active = navigation?.querySelector('[aria-current="page"]');
      if (!mobile.matches || sidebarCollapsed || !navigation || !active) return;
      const frame = navigation.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.left < frame.left || item.right > frame.right) navigation.scrollLeft += item.left - frame.left;
    };
    revealActive();
    mobile.addEventListener("change", revealActive);
    return () => mobile.removeEventListener("change", revealActive);
  }, [pathname, sidebarCollapsed]);

  useEffect(() => {
    document.title = "Agent Forge";
    let active = true;
    const loadRuntimeStatus = () => {
      void api.runtimeStatus().then((status) => {
        if (active) setRuntimeStatus(status);
      }).catch(() => {
        if (active) setRuntimeStatus(null);
      });
    };
    loadRuntimeStatus();
    const refreshWhenVisible = () => {
      if (!document.hidden) loadRuntimeStatus();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("autofix.sidebarCollapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("autofix.theme", theme);
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openIssueFromPalette = (issue: { id: number; kind: "issue" | "pr" }) => {
    navigate(issue.kind === "pr" ? "/pulls" : "/issues");
    setSelectedIssueId(issue.id);
  };

  const navGroups = [{ id: "work", label: "研发工作", short: "研发", icon: BriefcaseBusiness, items: [
    { to: "/dashboard", label: "概览", icon: Gauge },
    { to: "/issues", label: "问题", icon: Inbox },
    { to: "/pulls", label: "拉取请求", icon: GitPullRequestArrow },
    { to: "/notifications", label: "通知", icon: Bell },
    { to: "/todos", label: "待办", icon: ListTodo },
  ] }, { id: "lark", label: "飞书工作台", short: "飞书", icon: MessageSquareText, items: [
    { to: "/lark-messages", label: "消息", icon: MessageSquareText },
    { to: "/lark-tasks", label: "派工任务", icon: Workflow },
    { to: "/lark-managed-chats", label: "群聊", icon: Users },
    { to: "/group-privacy", label: "群聊隐私审批", icon: Shield },
    { to: "/agent-messaging", label: "Agent 消息路由", icon: RouteIcon },
    { to: "/personal-inbox", label: "个人收件箱", icon: Mail },
    { to: "/approvals", label: "审批记录", icon: ShieldCheck },
    { to: "/stickers", label: "表情包库", icon: Images },
  ] }, { id: "system", label: "系统", short: "系统", icon: Settings2, items: [
    { to: "/settings", label: "设置", icon: Settings2 },
    { to: "/runs", label: "运行记录", icon: Activity },
  ] }];
  const matchesPath = (to: string) => pathname === to || pathname.startsWith(to + "/");
  const activeGroup = navGroups.find(group => group.items.some(({ to }) => matchesPath(to))) ?? navGroups[0];
  const activePage = activeGroup.items.find(({ to }) => matchesPath(to)) ?? activeGroup.items[0];
  const showWorkStatus = activeGroup.id !== "lark";
  const showLarkStatus = activeGroup.id !== "work";

  return (
    <main className={`appShell${sidebarCollapsed ? " sidebarCollapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div className="brand">
            <div className="brandMark" aria-hidden="true"><WandSparkles size={19} strokeWidth={2.4} /></div>
            <div className="brandText">
              <strong>Agent Forge</strong>
            </div>
          </div>
          <button
            className="iconButton sidebarToggle"
            type="button"
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-pressed={sidebarCollapsed}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav className="workspaceSwitcher" aria-label="切换工作区">
          {navGroups.map(({ id, label, short, icon: Icon, items }) => (
            <Link key={id} to={id === activeGroup.id ? activePage.to : items[0].to} aria-label={label} title={label}
              aria-current={id === activeGroup.id ? "location" : undefined}>
              <Icon size={17} aria-hidden="true" /><span>{short}</span>
            </Link>
          ))}
        </nav>
        <nav ref={navigationRef} className="nav workspaceLinks" aria-label={activeGroup.label}>
          {activeGroup.items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} title={sidebarCollapsed ? label : undefined} aria-label={label}>
              <Icon size={17} aria-hidden="true" /><span className="navLabel">{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar workspaceTopbar">
          <div className="workspaceBreadcrumb"><span>{activeGroup.label}</span><ChevronRight size={14} aria-hidden="true" /><strong>{activePage.label}</strong></div>
          <div className="topbarActions">
            <button
              className="iconButton"
              type="button"
              title={theme === "light" ? "切换深色主题" : "切换浅色主题"}
              aria-label={theme === "light" ? "切换深色主题" : "切换浅色主题"}
              aria-pressed={theme === "dark"}
              onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <button className="commandShortcutButton" type="button" onClick={() => setCommandPaletteOpen(true)} title="全局搜索 (Cmd+K)" aria-label="全局搜索">
              <Command size={15} /> <span>搜索</span><kbd>K</kbd>
            </button>
            <div className="statusCluster" aria-label="本机运行状态">
              {showWorkStatus && <button className="statusItem" type="button" onClick={() => navigate("/issues")} title="查看最近 Gitea 同步">
                <RefreshCw size={14} />
                <span>{runtimeStatus?.lastGiteaSyncAt ? "已同步" : "未同步"}</span>
              </button>}
              {showWorkStatus && <button className={`statusItem ${runtimeStatus?.activeCodexJobs ? "active" : ""}`} type="button" onClick={() => navigate("/runs")} title="查看 Codex 运行记录">
                <Activity size={14} />
                <span>{runtimeStatus?.activeCodexJobs ?? 0} 运行中</span>
              </button>}
              {showLarkStatus && <button className={`statusItem ${runtimeStatus?.larkListenerRunning ? "ok" : "muted"}`} type="button" onClick={() => navigate("/lark-messages")} title="查看飞书消息">
                <MessageSquareText size={14} />
                <span>{runtimeStatus?.larkListenerRunning == null ? "飞书状态未知" : runtimeStatus.larkListenerRunning ? "飞书已监听" : "飞书未监听"}</span>
              </button>}
              {showWorkStatus && (runtimeStatus?.recentFailedJobs ?? 0) > 0 && (
                <button className="statusItem warning" type="button" onClick={() => navigate("/runs")} title="查看近期失败任务">
                  <CircleAlert size={14} />
                  <span>{runtimeStatus?.recentFailedJobs} 失败</span>
                </button>
              )}
            </div>
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard onOpenIssue={setSelectedIssueId} />} />
          <Route path="/issues" element={<IssueList onOpenIssue={setSelectedIssueId} />} />
          <Route path="/issues/:issueId" element={<IssueList onOpenIssue={setSelectedIssueId} />} />
          <Route path="/pulls" element={<PullRequestList onOpenIssue={setSelectedIssueId} />} />
          <Route path="/pulls/:issueId" element={<PullRequestList onOpenIssue={setSelectedIssueId} />} />
          <Route
            path="/notifications"
            element={
              <NotificationList
                notificationPermission={chromeNotifications.permission}
                onEnableChromeNotifications={chromeNotifications.requestPermission}
                onTestChromeNotification={chromeNotifications.sendTestNotification}
                onPushUnreadNotifications={chromeNotifications.pushUnreadNotifications}
              />
            }
          />
          <Route path="/todos" element={<TodoList />} />
          <Route path="/lark-messages" element={<LarkMessageList />} />
          <Route path="/lark-tasks/:taskId?" element={<LarkTasksPage />} />
          <Route path="/lark-managed-chats" element={<LarkManagedChatsPage />} />
          <Route path="/group-privacy" element={<GroupPrivacyPage />} />
          <Route path="/agent-messaging" element={<AgentMessagingPage />} />
          <Route path="/personal-inbox" element={<PersonalInboxPage />} />
          <Route path="/lark-messages/:messageId" element={<LarkMessageList />} />
          <Route path="/approvals" element={<ApprovalHistory />} />
          <Route path="/approvals/:kind/:approvalId" element={<ApprovalHistory />} />
          <Route path="/stickers" element={<StickerLibrary />} />
          <Route path="/runs" element={<RunList />} />
          <Route path="/runs/:jobId" element={<RunList />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/issues" replace />} />
        </Routes>
        {selectedIssueId !== null && (
          <IssueDetailDrawer
            issueId={selectedIssueId}
            onClose={() => setSelectedIssueId(null)}
            onOpenJob={(jobId) => {
              setSelectedIssueId(null);
              navigate(`/runs/${jobId}`);
            }}
          />
        )}
        {commandPaletteOpen && (
          <CommandPalette
            onClose={() => setCommandPaletteOpen(false)}
            onNavigate={(path) => navigate(path)}
            onOpenIssue={openIssueFromPalette}
            onOpenTodo={(todoId) => navigate(`/todos?todo=${todoId}`)}
          />
        )}
      </section>
    </main>
  );
}
