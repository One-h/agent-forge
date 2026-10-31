import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Download, FileText, FolderGit2, HardDrive, History, KeyRound, Power, RefreshCw, Save, Settings2, ShieldCheck, Stethoscope, Trash2, Upload } from "lucide-react";
import { api, type LarkCodexModel, type LaunchAgentStatus, type LocalAuditEvent, type LocalBackup, type LocalDataUsage, type LocalDiagnostic, type LocalRepository, type PromptKey, type PromptSettings, type RuntimeConfig, type Settings } from "../api";
import { CompanyScopeSettings } from "../components/CompanyScopeSettings";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { statusText } from "../i18n";
import { usePersistentState } from "../usePersistentState";

function diagnosticBadge(status: LocalDiagnostic["status"]): string {
  return status === "pass" ? "done" : status === "warn" ? "queued" : "failed";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function larkReactionAsset(emojiType: string): string {
  return `/lark-reactions/${encodeURIComponent(emojiType)}.png`;
}

const promptDefinitions: Array<{ key: PromptKey; label: string; description: string }> = [
  { key: "larkAssistant", label: "飞书默认人设", description: "未配置会话人设时使用；自定义会话人设会替换此处的角色与表达风格。权限、审批和消息协议独立生效。" },
  { key: "prReview", label: "PR 评审", description: "控制新建 PR 评审任务的审查指令。" },
  { key: "issueTriage", label: "Issue 分诊", description: "控制 Issue 分诊和开发计划输出。" },
  { key: "issueImplementation", label: "Issue 实现", description: "控制获批 Issue 的实现与验证要求。" }
];

const reasoningEffortOptions: Array<[Settings["appSettings"]["larkCodexReasoningEffort"], string]> = [
  ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "更高"], ["max", "最高"], ["ultra", "超高"]
];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [diagnostics, setDiagnostics] = useState<LocalDiagnostic[]>([]);
  const [repositories, setRepositories] = useState<LocalRepository[]>([]);
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [launchAgent, setLaunchAgent] = useState<LaunchAgentStatus | null>(null);
  const [localData, setLocalData] = useState<LocalDataUsage | null>(null);
  const [auditEvents, setAuditEvents] = useState<LocalAuditEvent[]>([]);
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeConfig>({ workspaceRoot: "", giteaBaseUrl: "", giteaBaseUrls: [], giteaUser: "", larkExecutionApproverId: "", trustedLarkCodexSenderIds: [] });
  const [wizardStep, setWizardStep] = useState(0);
  const [giteaToken, setGiteaToken] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState("10");
  const [larkGroupContextMessageLimit, setLarkGroupContextMessageLimit] = useState("50");
  const [larkGroupContextMaxChars, setLarkGroupContextMaxChars] = useState("6000");
  const [larkCodexModel, setLarkCodexModel] = useState("gpt-5.6-terra");
  const [larkTurnAutoApprovalModel, setLarkTurnAutoApprovalModel] = useState("gpt-6.1-sol");
  const [approvalDataSources, setApprovalDataSources] = useState("");
  const [deploymentAdapterPath, setDeploymentAdapterPath] = useState("");
  const [customApprovalModelMode, setCustomApprovalModelMode] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<LarkCodexModel[] | null>(null);
  const [modelCatalogError, setModelCatalogError] = useState(false);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [spontaneousChatIds, setSpontaneousChatIds] = useState("");
  const [ownerMentionAssistOwnerId, setOwnerMentionAssistOwnerId] = useState("");
  const [groupReactionChatIds, setGroupReactionChatIds] = useState("");
  const [spontaneousPercent, setSpontaneousPercent] = useState("8");
  const [spontaneousCooldownMinutes, setSpontaneousCooldownMinutes] = useState("10");
  const [retentionDays, setRetentionDays] = useState("30");
  const [saving, setSaving] = useState(false);
  const [contactsSyncing, setContactsSyncing] = useState(false);
  const [supportLoading, setSupportLoading] = useState(false);
  const [settingsSection, setSettingsSection] = usePersistentState<"common" | "automation" | "prompts" | "maintenance">("autofix.settings.section", "common");
  const [promptDrafts, setPromptDrafts] = useState<PromptSettings | null>(null);
  const [activePromptKey, setActivePromptKey] = useState<PromptKey>("larkAssistant");
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  const loadSupportingData = async (refresh = false) => {
    setSupportLoading(true);
    try {
      const [nextDiagnostics, nextRepositories, nextLaunchAgent, nextLocalData, nextAuditEvents] = await Promise.all([
        api.diagnostics(refresh), api.discoverRepositories(refresh), api.launchAgent(), api.localDataUsage(), api.localAudit()
      ]);
      setDiagnostics(nextDiagnostics);
      setRepositories(nextRepositories);
      setLaunchAgent(nextLaunchAgent);
      setLocalData(nextLocalData);
      setAuditEvents(nextAuditEvents);
    } finally {
      setSupportLoading(false);
    }
  };

  const load = async (refresh = false) => {
    const next = await api.settings();
    setSettings(next);
    setSelectedRepositories(next.giteaSync.repos);
    setRuntimeDraft(next.runtimeConfig);
    setPromptDrafts(next.prompts);
    setPollIntervalMinutes(String(Math.round(next.pollIntervalMs / 60000)));
    setLarkGroupContextMessageLimit(String(next.appSettings.larkGroupContextMessageLimit));
    setLarkGroupContextMaxChars(String(next.appSettings.larkGroupContextMaxChars));
    setLarkCodexModel(next.appSettings.larkCodexModel || "gpt-5.6-terra");
    setLarkTurnAutoApprovalModel(next.appSettings.larkTurnAutoApprovalModel || "gpt-6.1-sol");
    setApprovalDataSources((next.appSettings.larkTurnAutoApprovalDataSources ?? []).join("\n"));
    setDeploymentAdapterPath(next.appSettings.deploymentAdapterPath ?? "");
    setSpontaneousChatIds((next.appSettings.larkGroupSpontaneousChatIds ?? []).join("\n"));
    setOwnerMentionAssistOwnerId(next.appSettings.larkOwnerMentionAssistOwnerId ?? "");
    setGroupReactionChatIds((next.appSettings.larkGroupMessageReactionChatIds ?? []).join("\n"));
    setSpontaneousPercent(String(Number(((next.appSettings.larkGroupSpontaneousReplyRate ?? 0.08) * 100).toFixed(4))));
    setSpontaneousCooldownMinutes(String(Number(((next.appSettings.larkGroupSpontaneousReplyCooldownMs ?? 600_000) / 60_000).toFixed(4))));
    void loadSupportingData(refresh).catch((err) => setError(String(err)));
  };

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, []);

  const refreshModelCatalog = async () => {
    setModelCatalogError(false);
    try { setModelCatalog((await api.larkModels()).models); }
    catch { setModelCatalog([]); setModelCatalogError(true); }
  };

  useEffect(() => {
    if (settingsSection === "automation") void refreshModelCatalog();
  }, [settingsSection]);

  const updateSetting = async (patch: Partial<Settings["appSettings"]>) => {
    if (!settings) return;
    setSaving(true);
    setError("");
    setNotice("");
    setSettings({ ...settings, appSettings: { ...settings.appSettings, ...patch } });
    try {
      const appSettings = await api.updateSettings(patch);
      const refreshed = await api.settings();
      for (const key of ["larkOwnerMentionAssistEnabled", "larkOwnerMentionAssistOwnerId", "larkTopicNativeModeEnabled"] as const) {
        if (patch[key] !== undefined && (refreshed.larkSettingsKnown?.[key] !== true || refreshed.appSettings[key] !== patch[key])) {
          throw new Error(key === "larkTopicNativeModeEnabled" ? "话题模式配置未确认，请刷新后重试。" : "群聊协同配置未确认，请刷新后重试。");
        }
      }
      setSettings({ ...refreshed, appSettings: { ...appSettings, larkTurnAutoApprovalModel: refreshed.appSettings.larkTurnAutoApprovalModel } });
      setOwnerMentionAssistOwnerId(refreshed.appSettings.larkOwnerMentionAssistOwnerId ?? "");
      setLarkTurnAutoApprovalModel(refreshed.appSettings.larkTurnAutoApprovalModel);
      setApprovalDataSources((refreshed.appSettings.larkTurnAutoApprovalDataSources ?? []).join("\n"));
      setDeploymentAdapterPath(refreshed.appSettings.deploymentAdapterPath ?? "");
    } catch (err) {
      setError(String(err));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const savePollInterval = async () => {
    const minutes = Number(pollIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      setError("Gitea 同步间隔必须在 1 到 1440 分钟之间。");
      return;
    }
    await updateSetting({ pollIntervalMs: Math.round(minutes) * 60_000 });
  };

  const syncLarkContacts = async () => {
    setContactsSyncing(true);
    setError("");
    setNotice("");
    try {
      const result = await api.syncLarkContacts();
      setNotice(result.hasMore
        ? `已更新 ${result.upserted} 位已聊天联系人；结果超过 30 人，请使用搜索进一步补全。`
        : `已更新飞书人员列表：同步 ${result.scanned} 位已聊天联系人，更新 ${result.upserted} 位。`);
    } catch (err) {
      setError(String(err));
    } finally {
      setContactsSyncing(false);
    }
  };

  const saveLarkGroupContextLimits = async () => {
    const messageLimit = Number(larkGroupContextMessageLimit);
    const maxChars = Number(larkGroupContextMaxChars);
    if (!Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 200) {
      setError("群聊上下文消息条数必须在 1 到 200 之间。");
      return;
    }
    if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 30_000) {
      setError("群聊上下文总文本必须在 500 到 30000 字符之间。");
      return;
    }
    await updateSetting({ larkGroupContextMessageLimit: messageLimit, larkGroupContextMaxChars: maxChars });
  };

  const saveRepositories = async (): Promise<boolean> => {
    if (!settings) return false;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const giteaSync = await api.updateGiteaRepositories(selectedRepositories);
      setSettings({ ...settings, giteaSync });
      return true;
    } catch (err) {
      setError(String(err));
      await load();
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveGiteaToken = async (): Promise<boolean> => {
    if (!giteaToken.trim()) {
      setError("请输入 Gitea token。");
      return false;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.saveGiteaToken(giteaToken.trim());
      setGiteaToken("");
      await load();
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveRuntimeConfig = async (): Promise<boolean> => {
    const workspaceRoot = runtimeDraft.workspaceRoot.trim();
    const giteaBaseUrls = [...new Set(runtimeDraft.giteaBaseUrls.map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean))];
    if (!workspaceRoot.startsWith("/")) {
      setError("工作区必须是绝对路径。");
      return false;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.updateRuntimeConfig({
        workspaceRoot,
        giteaBaseUrl: giteaBaseUrls[0] ?? "",
        giteaBaseUrls,
        giteaUser: runtimeDraft.giteaUser.trim(),
        larkExecutionApproverId: runtimeDraft.larkExecutionApproverId.trim(),
        trustedLarkCodexSenderIds: runtimeDraft.trustedLarkCodexSenderIds
      });
      setNotice("基础配置已保存到本机数据库。");
      await load();
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const savePrompt = async () => {
    if (!settings || !promptDrafts) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const prompts = await api.updatePrompts({ [activePromptKey]: promptDrafts[activePromptKey].value });
      setPromptDrafts(prompts);
      setSettings({ ...settings, prompts });
      setNotice("提示词已保存；当前轮次（含追加消息）保持原配置，下轮对话或新任务使用新配置。");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const resetPrompt = async () => {
    if (!settings) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const prompts = await api.updatePrompts({ [activePromptKey]: null });
      setPromptDrafts(prompts);
      setSettings({ ...settings, prompts });
      setNotice("已还原默认提示词；当前轮次（含追加消息）保持原配置，下轮对话或新任务使用默认配置。");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleRepository = (repo: string, checked: boolean) => {
    setSelectedRepositories((current) => checked ? [...new Set([...current, repo])] : current.filter((value) => value !== repo));
  };

  const refreshAudit = async () => setAuditEvents(await api.localAudit());

  const installLaunchAgent = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const status = await api.installLaunchAgent();
      setLaunchAgent(status);
      setNotice(status.startDeferred ? "已安装。当前开发服务占用端口，请在停止开发服务后点击“重启”，或在下次登录时启动。" : "已安装并启动常驻服务。");
      await refreshAudit();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const restartLaunchAgent = async () => {
    setSaving(true);
    setError("");
    try {
      await api.restartLaunchAgent();
      setNotice("已安排重启常驻服务。");
      await refreshAudit();
      window.setTimeout(() => void load().catch((err) => setError(String(err))), 1_000);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const uninstallLaunchAgent = async () => {
    setSaving(true);
    setError("");
    try {
      await api.uninstallLaunchAgent();
      setNotice("已安排移除常驻服务。");
      await refreshAudit();
      window.setTimeout(() => void load().catch((err) => setError(String(err))), 1_000);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const cleanupLocalData = async (target: "completed-task-artifacts" | "launchd-logs") => {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3_650) {
      setError("保留天数必须在 1 到 3650 之间。");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.cleanupLocalData(target, days);
      setLocalData(result.usage);
      setNotice(`已清理 ${result.removedCount} 项，释放 ${formatBytes(result.reclaimedBytes)}。`);
      await refreshAudit();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const completeOnboarding = async () => {
    setSaving(true);
    setError("");
    try {
      await api.completeOnboarding();
      setNotice("首次配置已完成。");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const exportBackup = async () => {
    setSaving(true);
    setError("");
    try {
      const backup = await api.localBackup();
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `autofix-backup-${backup.exportedAt.slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("本机备份已导出。备份不包含 token 和飞书登录态。");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const restoreBackup = async (file: File) => {
    setError("");
    try {
      const backup = JSON.parse(await file.text()) as LocalBackup;
      if (backup.schemaVersion !== 1) throw new Error("不支持的备份版本。");
      setConfirmation({
        title: "恢复本机备份",
        description: `将覆盖当前基础配置、功能开关、仓库选择、待办和审计记录，并导入 ${backup.todos.length} 条待办与 ${backup.auditEvents.length} 条审计记录。token、飞书登录态和任务产物不会恢复。`,
        confirmLabel: "确认恢复",
        destructive: true,
        onConfirm: async () => {
          setSaving(true);
          setError("");
          try {
            const result = await api.restoreLocalBackup(backup);
            setNotice(`已恢复 ${result.todos} 条待办和 ${result.auditEvents} 条审计记录。`);
            await load();
          } catch (err) {
            setError(String(err));
          } finally {
            setSaving(false);
          }
        }
      });
    } catch (err) {
      setError(String(err));
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  };

  if (!settings) {
    return <section className="panel">正在加载设置...</section>;
  }

  const repositoryChoices = new Map<string, LocalRepository>();
  for (const repository of repositories) {
    if (repository.repo) repositoryChoices.set(repository.repo, repository);
  }
  for (const repo of selectedRepositories) {
    if (!repositoryChoices.has(repo)) repositoryChoices.set(repo, { name: repo, path: "", remote: "", repo });
  }
  const activePrompt = (promptDrafts ?? settings.prompts)[activePromptKey];
  const activePromptDefinition = promptDefinitions.find((prompt) => prompt.key === activePromptKey)!;
  const selectedCatalogModel = modelCatalog?.find((model) => model.id === settings.appSettings.larkCodexModel);
  const showCustomModelInput = modelCatalog !== null && (modelCatalog.length === 0 || customModelMode || !selectedCatalogModel);
  const showCustomApprovalModelInput = !modelCatalog?.length || customApprovalModelMode || !modelCatalog.some((model) => model.id === settings.appSettings.larkTurnAutoApprovalModel);
  const approvalModelDisabled = saving || !settings.larkCodexResponder.turnAutoApprovalModelConfigurable;
  const currentReasoningEffort = settings.appSettings.larkCodexReasoningEffort ?? "low";
  const supportedEfforts = selectedCatalogModel && !customModelMode
    ? reasoningEffortOptions.filter(([value]) => selectedCatalogModel.efforts.includes(value))
    : [];
  const visibleEfforts = supportedEfforts.length > 0 ? supportedEfforts : reasoningEffortOptions;

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">本机运行时</p>
          <h2>设置</h2>
          <p className="subtle">此设备的仓库、凭据与自动化能力。</p>
        </div>
        <button className="ghostButton" onClick={() => void load(true)}><RefreshCw className={supportLoading ? "spin" : undefined} size={16} /> 刷新</button>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="settingsSectionNav">
        <div className="segmentedControl" aria-label="设置分类">
          <button className={settingsSection === "common" ? "active" : ""} onClick={() => setSettingsSection("common")} type="button">常用</button>
          <button className={settingsSection === "automation" ? "active" : ""} onClick={() => setSettingsSection("automation")} type="button">自动化</button>
          <button className={settingsSection === "prompts" ? "active" : ""} onClick={() => setSettingsSection("prompts")} type="button">提示词</button>
          <button className={settingsSection === "maintenance" ? "active" : ""} onClick={() => setSettingsSection("maintenance")} type="button">本机维护</button>
        </div>
        <span className="subtle">{settingsSection === "common" ? "连接服务、凭据、仓库和同步策略" : settingsSection === "automation" ? "控制自动评审、Issue 修复和飞书执行权限" : settingsSection === "prompts" ? "编辑飞书与工程任务的 Codex 指令" : "检查环境、管理常驻服务和本机数据"}</span>
      </div>
      {!settings.setupComplete && (
        <section className="panel onboardingPanel">
          <div className="onboardingHeader"><div><p className="eyebrow">首次配置</p><h3>配置本机工作台</h3></div><span>{wizardStep + 1} / 4</span></div>
          <div className="onboardingSteps" aria-label="首次配置进度"><span className={wizardStep === 0 ? "active" : "done"}>基础配置</span><span className={wizardStep === 1 ? "active" : wizardStep > 1 ? "done" : ""}>凭据</span><span className={wizardStep === 2 ? "active" : wizardStep > 2 ? "done" : ""}>仓库</span><span className={wizardStep === 3 ? "active" : ""}>检查</span></div>
          {wizardStep === 0 && <div className="onboardingBody">
            <div className="settingsField firstSettingField"><label htmlFor="onboardingWorkspaceRoot">工作区路径</label><input disabled={saving} id="onboardingWorkspaceRoot" onChange={(event) => setRuntimeDraft((current) => ({ ...current, workspaceRoot: event.target.value }))} placeholder="/Users/name/Documents/workspace" value={runtimeDraft.workspaceRoot} /></div>
            <CompanyScopeSettings suggestedRoot={runtimeDraft.workspaceRoot} />
            <div className="settingsField"><label htmlFor="onboardingGiteaUrls">Gitea 地址（可选）</label><textarea disabled={saving} id="onboardingGiteaUrls" onChange={(event) => setRuntimeDraft((current) => ({ ...current, giteaBaseUrls: event.target.value.split(/\r?\n/) }))} placeholder={"https://gitea.example.com\nhttps://git.example.com"} rows={3} value={runtimeDraft.giteaBaseUrls.join("\n")} /><small>每行一个地址；首个地址用于 API 同步，其余地址用于识别本机仓库 remote。</small></div>
            <div className="settingsField"><label htmlFor="onboardingGiteaUser">Gitea 用户名（可选）</label><input disabled={saving} id="onboardingGiteaUser" onChange={(event) => setRuntimeDraft((current) => ({ ...current, giteaUser: event.target.value }))} placeholder="用于筛选待评审 PR" value={runtimeDraft.giteaUser} /></div>
            <div className="inlineActions"><button disabled={saving} onClick={() => void saveRuntimeConfig().then((saved) => saved && setWizardStep(1))} type="button">保存并继续</button></div>
          </div>}
          {wizardStep === 1 && <div className="onboardingBody">
            <dl className="meta wide"><dt>当前凭据</dt><dd>{settings.giteaCredential.source === "missing" ? "未配置" : settings.giteaCredential.source === "keychain" ? "macOS 钥匙串" : "tea 登录态"}</dd></dl>
            <div className="settingsField"><label htmlFor="onboardingGiteaToken">Gitea token</label><div className="inlineControl"><input autoComplete="off" disabled={saving || !settings.giteaCredential.keychainAvailable} id="onboardingGiteaToken" onChange={(event) => setGiteaToken(event.target.value)} placeholder="保存到 macOS 钥匙串" type="password" value={giteaToken} /><button disabled={saving || !giteaToken.trim() || !settings.giteaCredential.keychainAvailable} onClick={() => void saveGiteaToken()} type="button">保存</button></div></div>
            <div className="inlineActions"><button className="ghostButton" disabled={saving} onClick={() => setWizardStep(0)} type="button">上一步</button><button disabled={saving} onClick={() => setWizardStep(2)} type="button">继续</button></div>
          </div>}
          {wizardStep === 2 && <div className="onboardingBody">
            <div className="onboardingRepositories">{[...repositoryChoices.entries()].map(([repo]) => <label className="toggleRow" key={repo}><input checked={selectedRepositories.includes(repo)} disabled={saving} onChange={(event) => toggleRepository(repo, event.target.checked)} type="checkbox" /><span className="toggleTrack" aria-hidden="true" /><span><strong>{repo}</strong></span></label>)}{repositoryChoices.size === 0 && <div className="emptyState small">保存 Gitea 地址后，刷新页面以发现本机仓库。</div>}</div>
            <div className="inlineActions"><button className="ghostButton" disabled={saving} onClick={() => setWizardStep(1)} type="button">上一步</button><button disabled={saving} onClick={() => void saveRepositories().then((saved) => saved && setWizardStep(3))} type="button">保存并继续</button></div>
          </div>}
          {wizardStep === 3 && <div className="onboardingBody">
            <dl className="meta wide"><dt>环境检查</dt><dd>{diagnostics.filter((item) => item.status === "fail").length === 0 ? "未发现阻塞项" : "存在需要处理的异常"}</dd><dt>Gitea 同步</dt><dd>{settings.giteaSync.configured ? "已配置" : "未配置，可稍后在设置中开启"}</dd><dt>仓库</dt><dd>{selectedRepositories.length} 个已选择</dd></dl>
            <div className="inlineActions"><button className="ghostButton" disabled={saving} onClick={() => setWizardStep(2)} type="button">上一步</button><button disabled={saving} onClick={() => void completeOnboarding()} type="button"><CheckCircle2 size={15} /> 完成配置</button></div>
          </div>}
        </section>
      )}
      <div className="settingsGrid">
        {settingsSection === "maintenance" && <div className="panel">
          <h3><Stethoscope size={16} /> 环境自检</h3>
          <dl className="meta wide">
            {diagnostics.map((item) => <Fragment key={item.key}><dt>{item.label}</dt><dd><span className={`badge ${diagnosticBadge(item.status)}`}>{item.status === "pass" ? "正常" : item.status === "warn" ? "注意" : "异常"}</span> {item.detail}</dd></Fragment>)}
          </dl>
        </div>}

        {settingsSection === "common" && <div className="panel">
          <h3><Settings2 size={16} /> 基础配置</h3>
          <div className="settingsField firstSettingField">
            <label htmlFor="workspaceRoot">工作区路径</label>
            <input disabled={saving} id="workspaceRoot" onChange={(event) => setRuntimeDraft((current) => ({ ...current, workspaceRoot: event.target.value }))} placeholder="/Users/name/Documents/workspace" value={runtimeDraft.workspaceRoot} />
          </div>
          <div className="settingsField">
            <label htmlFor="giteaBaseUrls">Gitea 地址</label>
            <textarea disabled={saving} id="giteaBaseUrls" onChange={(event) => setRuntimeDraft((current) => ({ ...current, giteaBaseUrls: event.target.value.split(/\r?\n/) }))} placeholder={"https://gitea.example.com\nhttps://git.example.com"} rows={3} value={runtimeDraft.giteaBaseUrls.join("\n")} />
            <small>每行一个地址；首个地址用于 API 同步，其余地址用于匹配 Git SSH/HTTP remote。</small>
          </div>
          <div className="settingsField">
            <label htmlFor="giteaUser">Gitea 用户名</label>
            <input disabled={saving} id="giteaUser" onChange={(event) => setRuntimeDraft((current) => ({ ...current, giteaUser: event.target.value }))} placeholder="用于筛选待评审 PR" value={runtimeDraft.giteaUser} />
          </div>
          <div className="settingsField">
            <label htmlFor="larkExecutionApproverId">执行审批接收人</label>
            <input disabled={saving} id="larkExecutionApproverId" onChange={(event) => setRuntimeDraft((current) => ({ ...current, larkExecutionApproverId: event.target.value }))} placeholder="你的飞书 Open ID（ou_xxx）" value={runtimeDraft.larkExecutionApproverId} />
            <small>所有非可信发送人的执行审批都固定发送给此账号；开启高权限执行后，此账号也默认视为可信发送人。</small>
          </div>
          <div className="settingsField">
            <label htmlFor="trustedLarkIds">可信飞书 ID</label>
            <input disabled={saving} id="trustedLarkIds" onChange={(event) => setRuntimeDraft((current) => ({ ...current, trustedLarkCodexSenderIds: event.target.value.split(/[,，;；\r\n]+/).map((value) => value.trim()).filter(Boolean) }))} placeholder="ou_xxx, ou_yyy" value={runtimeDraft.trustedLarkCodexSenderIds.join(", ")} />
            <small>用于额外授权他人；执行审批接收人无需重复填写。</small>
          </div>
          <div className="inlineActions"><button disabled={saving} onClick={() => void saveRuntimeConfig()} type="button">保存基础配置</button></div>
        </div>}

        {settingsSection === "common" && settings.setupComplete && <section className="panel"><CompanyScopeSettings suggestedRoot={runtimeDraft.workspaceRoot} /></section>}

        {settingsSection === "common" && <div className="panel">
          <h3><KeyRound size={16} /> Gitea 凭据</h3>
          <dl className="meta wide">
            <dt>存储</dt><dd>{settings.giteaCredential.source === "keychain" ? "macOS 钥匙串" : settings.giteaCredential.source === "missing" ? "未配置" : settings.giteaCredential.source}</dd>
            <dt>服务地址</dt><dd>{settings.runtimeConfig.giteaBaseUrls.length > 0 ? settings.runtimeConfig.giteaBaseUrls.join("、") : "未配置"}</dd>
          </dl>
          <div className="settingsField">
            <label htmlFor="giteaToken">Gitea token</label>
            <div className="inlineControl">
              <input autoComplete="off" disabled={saving || !settings.giteaCredential.keychainAvailable} id="giteaToken" onChange={(event) => setGiteaToken(event.target.value)} placeholder="保存到 macOS 钥匙串" type="password" value={giteaToken} />
              <button disabled={saving || !settings.giteaCredential.keychainAvailable} onClick={() => void saveGiteaToken()} type="button">保存</button>
            </div>
          </div>
        </div>}

        {settingsSection === "common" && <div className="panel">
          <h3><FolderGit2 size={16} /> 仓库</h3>
          <dl className="meta wide">
            <dt>同步状态</dt><dd><span className={`badge ${settings.giteaSync.configured ? "done" : "failed"}`}>{statusText(settings.giteaSync.configured ? "configured" : "missing")}</span></dd>
            <dt>用户筛选</dt><dd>{settings.giteaSync.userFilter || "-"}</dd>
          </dl>
          <div className="toggleStack">
            {[...repositoryChoices.entries()].map(([repo, repository]) => (
              <label className="toggleRow" key={repo} title={repository.path || repository.remote}>
                <input checked={selectedRepositories.includes(repo)} disabled={saving} onChange={(event) => toggleRepository(repo, event.target.checked)} type="checkbox" />
                <span className="toggleTrack" aria-hidden="true" />
                <span><strong>{repo}</strong><small>{repository.path || "当前已配置，未在本机工作区发现"}</small></span>
              </label>
            ))}
            {repositoryChoices.size === 0 && <div className="emptyState small">未在工作区中发现带 origin remote 的仓库。</div>}
          </div>
          <div className="inlineActions"><button disabled={saving} onClick={() => void saveRepositories()} type="button">保存仓库选择</button></div>
        </div>}

        {settingsSection === "common" && <div className="panel">
          <h3><Settings2 size={16} /> Gitea 同步</h3>
          <div className="settingsField">
            <label htmlFor="pollIntervalMinutes">同步间隔</label>
            <div className="inlineControl">
              <input disabled={saving} id="pollIntervalMinutes" max={1440} min={1} onChange={(event) => setPollIntervalMinutes(event.target.value)} step={1} type="number" value={pollIntervalMinutes} />
              <span>分钟</span><button disabled={saving} onClick={() => void savePollInterval()} type="button">保存</button>
            </div>
          </div>
          <SettingToggle checked={settings.appSettings.autoReviewNewPulls} disabled={saving} label="自动评审新 PR" onChange={(checked) => void updateSetting({ autoReviewNewPulls: checked })} />
        </div>}

        {settingsSection === "automation" && <div className="panel">
          <h3><ShieldCheck size={16} /> 权限与执行</h3>
          <dl className="meta wide">
            <dt>工作区</dt><dd>{settings.workspaceRoot}</dd>
            <dt>允许仓库</dt><dd>{selectedRepositories.length} 个</dd>
            <dt>Issue 修复</dt><dd>{settings.appSettings.issueRepairEnabled ? "允许" : "关闭"}</dd>
            <dt>可信飞书</dt><dd>{settings.larkCodexResponder.trustedSenderCount} 人，{!settings.larkCodexResponder.trustedExecutionConfigurable ? "权限状态未确认" : settings.appSettings.larkTrustedExecutionEnabled ? "高权限已开启" : "只读"}</dd>
            <dt>模型</dt><dd>{settings.codexModel || "默认"}</dd>
          </dl>
          <SettingToggle checked={settings.appSettings.issueRepairEnabled} disabled={saving} label="允许 Issue 修复" onChange={(checked) => void updateSetting({ issueRepairEnabled: checked })} />
        </div>}

        {settingsSection === "prompts" && <div className="panel promptEditor">
          <h3><FileText size={16} /> Codex 提示词</h3>
          <p className="subtle">修改会保存到本机数据库。当前轮次（含追加消息）保持原提示词和人设，下轮对话或新任务使用新配置。</p>
          <div className="segmentedControl" aria-label="提示词类别">
            {promptDefinitions.map((prompt) => <button className={activePromptKey === prompt.key ? "active" : ""} key={prompt.key} onClick={() => setActivePromptKey(prompt.key)} type="button">{prompt.label}</button>)}
          </div>
          <div className="promptEditorHeader">
            <div><strong>{activePromptDefinition.label}</strong><span>{activePromptDefinition.description}</span></div>
            <span className={`badge ${activePrompt.customized ? "queued" : "done"}`}>{activePrompt.customized ? "自定义" : "默认"}</span>
          </div>
          <label className="settingsField firstSettingField" htmlFor={`prompt-${activePromptKey}`}>
            <span>提示词内容</span>
            <textarea disabled={saving} id={`prompt-${activePromptKey}`} onChange={(event) => setPromptDrafts((current) => current ? { ...current, [activePromptKey]: { ...current[activePromptKey], value: event.target.value } } : current)} spellCheck={false} value={activePrompt.value} />
          </label>
          <div className="inlineActions">
            <button disabled={saving} onClick={() => void savePrompt()} type="button">保存提示词</button>
            <button className="ghostButton" disabled={saving || !activePrompt.customized} onClick={() => void resetPrompt()} type="button">还原默认</button>
          </div>
        </div>}

        {settingsSection === "automation" && <div className="panel">
          <h3>飞书消息</h3>
          <dl className="meta wide">
            <dt>监听器</dt><dd><span className={`badge ${settings.larkMessageListener.running ? "done" : settings.appSettings.larkMessageListenerEnabled ? "queued" : "blocked"}`}>{settings.larkMessageListener.running ? "运行中" : settings.appSettings.larkMessageListenerEnabled ? "启动中" : "关闭"}</span></dd>
            <dt>Codex 通道</dt><dd>{settings.larkCodexResponder.transport === "app-server" ? `App Server${settings.larkCodexResponder.running ? `，${settings.larkCodexResponder.activeTurns} 个活动会话` : "，按需启动"}` : settings.larkCodexResponder.transport}</dd>
            <dt>沙箱</dt><dd>{settings.larkCodexResponder.sandbox}</dd>
            <dt>原生模型</dt><dd>{settings.larkCodexResponder.native.available ? `${settings.larkCodexResponder.native.models.length} 个，${settings.larkCodexResponder.native.configuredModelAvailable ? "当前配置可用" : "当前配置未在目录中"}` : "App Server 未启动"}</dd>
            <dt>原生技能</dt><dd>{settings.larkCodexResponder.native.available ? `${settings.larkCodexResponder.native.skills.filter((skill) => skill.enabled).length} 个已启用` : "App Server 未启动"}</dd>
            <dt>原生线程</dt><dd>{settings.larkCodexResponder.native.threads.length > 0 ? settings.larkCodexResponder.native.threads.map((thread) => `${thread.name ?? thread.id}（${thread.status}）`).join("；") : "无活动线程"}</dd>
          </dl>
          <div className="settingsField">
            <label htmlFor="larkAcknowledgeReactionEmoji">收到消息表情</label>
            <div aria-label="收到消息表情" className="reactionPicker" id="larkAcknowledgeReactionEmoji" role="listbox">
              {settings.larkMessageListener.acknowledgeReactionOptions.map((emojiType) => {
                const selected = settings.appSettings.larkAcknowledgeReactionEmoji === emojiType;
                return <button aria-label={emojiType} aria-selected={selected} className={`reactionOption${selected ? " selected" : ""}`} disabled={saving} key={emojiType} onClick={() => void updateSetting({ larkAcknowledgeReactionEmoji: emojiType })} role="option" title={emojiType} type="button">
                  <img alt="" src={larkReactionAsset(emojiType)} />
                  {selected && <CheckCircle2 aria-hidden="true" size={13} />}
                </button>;
              })}
            </div>
          </div>
          <SettingToggle checked={settings.appSettings.larkGroupMessageReactionEnabled} disabled={saving} label="群聊每条消息自动点表情" onChange={(checked) => void updateSetting({ larkGroupMessageReactionEnabled: checked })} />
          {settings.appSettings.larkGroupMessageReactionEnabled && <div className="settingsField">
            <label htmlFor="larkGroupMessageReactionEmoji">群聊自动表情</label>
            <p className="subtle">对监听器首次收到的每条群消息添加一次；不要求对方 @ 机器人。</p>
            <div aria-label="群聊自动表情" className="reactionPicker" id="larkGroupMessageReactionEmoji" role="listbox">
              {settings.larkMessageListener.acknowledgeReactionOptions.map((emojiType) => {
                const selected = settings.appSettings.larkGroupMessageReactionEmoji === emojiType;
                return <button aria-label={emojiType} aria-selected={selected} className={`reactionOption${selected ? " selected" : ""}`} disabled={saving} key={emojiType} onClick={() => void updateSetting({ larkGroupMessageReactionEmoji: emojiType })} role="option" title={emojiType} type="button">
                  <img alt="" src={larkReactionAsset(emojiType)} />
                  {selected && <CheckCircle2 aria-hidden="true" size={13} />}
                </button>;
              })}
            </div>
            <label htmlFor="groupReactionChatIds">自动表情群白名单（空名单不生效）</label>
            <textarea id="groupReactionChatIds" disabled={saving} rows={3} placeholder={"oc_群ID1\noc_群ID2"} value={groupReactionChatIds} onChange={(event) => setGroupReactionChatIds(event.target.value)} />
            <div className="inlineActions"><button disabled={saving} type="button" onClick={() => void updateSetting({ larkGroupMessageReactionChatIds: [...new Set(groupReactionChatIds.split(/[,，;；\s]+/).filter(Boolean))] })}>保存白名单</button></div>
          </div>}
          <div className="settingsField">
            <label>飞书人员列表</label>
            <p className="subtle">从当前飞书账号的已聊天联系人同步姓名和 Open ID，用于显示姓名、真实 @ 与定向发送。</p>
            <div className="inlineActions">
              <button disabled={saving || contactsSyncing} onClick={() => void syncLarkContacts()} type="button"><RefreshCw className={contactsSyncing ? "spin" : undefined} size={15} /> 更新人员列表</button>
            </div>
          </div>
          <div className="settingsField">
            <label>群聊上下文</label>
            <p className="subtle">仅在机器人被 @ 时追加未读群消息；图片只保留占位，超出总文本上限时优先保留最新消息。</p>
            <div className="inlineControl">
              <input aria-label="群聊上下文消息条数" disabled={saving} max={200} min={1} onChange={(event) => setLarkGroupContextMessageLimit(event.target.value)} step={1} type="number" value={larkGroupContextMessageLimit} />
              <span>条</span>
              <input aria-label="群聊上下文总字符数" disabled={saving} max={30000} min={500} onChange={(event) => setLarkGroupContextMaxChars(event.target.value)} step={100} type="number" value={larkGroupContextMaxChars} />
              <span>字符</span>
              <button disabled={saving} onClick={() => void saveLarkGroupContextLimits()} type="button">保存</button>
            </div>
          </div>
          <SettingToggle checked={settings.appSettings.larkMessageListenerEnabled} disabled={saving} label="监听飞书消息" onChange={(checked) => void updateSetting({ larkMessageListenerEnabled: checked })} />
          <SettingToggle checked={settings.appSettings.larkCodexRepliesEnabled} disabled={saving} label="使用 Codex 回复" onChange={(checked) => void updateSetting({ larkCodexRepliesEnabled: checked })} />
          <SettingToggle checked={settings.appSettings.larkExecutionReceiptsEnabled} disabled={saving} label="发送执行回执卡片" onChange={(checked) => void updateSetting({ larkExecutionReceiptsEnabled: checked })} />
          <div className="settingsField">
            <label>表情包使用</label>
            <p className="subtle">控制 Codex 何时主动搜索并选择表情包。“每次回复”仅使用强提示词约束，不做服务端补发或校验。</p>
            <div aria-label="表情包使用策略" className="segmentedControl" role="radiogroup">
              {([
                ["off", "关闭"],
                ["explicit", "明确请求"],
                ["natural", "自然使用"],
                ["always", "每次回复"]
              ] as const).map(([value, label]) => (
                <button
                  aria-checked={settings.appSettings.larkStickerUsageMode === value}
                  className={settings.appSettings.larkStickerUsageMode === value ? "active" : ""}
                  disabled={saving}
                  key={value}
                  onClick={() => void updateSetting({ larkStickerUsageMode: value })}
                  role="radio"
                  type="button"
                >{label}</button>
              ))}
            </div>
          </div>
          <div className="settingsField">
            <label htmlFor="larkCodexModel">飞书会话模型</label>
            <p className="subtle">后续飞书消息使用当前模型；进行中的回合不变。</p>
            <div className="inlineControl larkModelControl">
              {modelCatalog === null
                ? <select id="larkCodexModel" disabled value="loading"><option value="loading">正在读取模型...</option></select>
                : modelCatalog.length > 0 && <select
                  id="larkCodexModel"
                  disabled={saving}
                  value={showCustomModelInput ? "__custom__" : settings.appSettings.larkCodexModel}
                  onChange={(event) => {
                    const modelId = event.target.value;
                    if (modelId === "__custom__") { setCustomModelMode(true); return; }
                    const model = modelCatalog.find((candidate) => candidate.id === modelId);
                    const supported = reasoningEffortOptions.map(([value]) => value).filter((value) => model?.efforts.includes(value));
                    setCustomModelMode(false);
                    setLarkCodexModel(modelId);
                    void updateSetting({ larkCodexModel: modelId, ...(supported.length > 0 && !supported.includes(currentReasoningEffort) ? { larkCodexReasoningEffort: supported[0] } : {}) });
                  }}
                >
                  {modelCatalog.map((model) => <option key={model.id} value={model.id}>{model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`}</option>)}
                  <option value="__custom__">自定义模型...</option>
                </select>}
              {modelCatalog !== null && <button aria-label="刷新模型列表" className="ghostButton" disabled={saving} onClick={() => void refreshModelCatalog()} title="刷新模型列表" type="button"><RefreshCw size={16} /></button>}
            </div>
            {showCustomModelInput && <div className="inlineControl larkModelControl">
              <input aria-label="自定义模型 ID" id={modelCatalog?.length === 0 ? "larkCodexModel" : undefined} type="text" maxLength={120} disabled={saving} value={larkCodexModel} onChange={(event) => setLarkCodexModel(event.target.value)} placeholder="gpt-5.6-terra" />
              <button type="button" disabled={saving || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(larkCodexModel.trim()) || larkCodexModel.trim() === settings.appSettings.larkCodexModel} onClick={() => void updateSetting({ larkCodexModel: larkCodexModel.trim() })}>保存模型</button>
            </div>}
            {modelCatalogError && <span className="subtle" role="status">模型列表暂不可用，可手动输入模型 ID。</span>}
          </div>
          <div className="settingsField">
            <label htmlFor="larkCodexReasoningEffort">思考等级</label>
            <select
              id="larkCodexReasoningEffort"
              disabled={saving || !settings.larkCodexResponder.reasoningEffortConfigurable}
              title={settings.larkCodexResponder.reasoningEffortConfigurable ? undefined : "需更新 Lark Agent 后使用"}
              value={currentReasoningEffort}
              onChange={(event) => void updateSetting({ larkCodexReasoningEffort: event.target.value as Settings["appSettings"]["larkCodexReasoningEffort"] })}
            >
              {!visibleEfforts.some(([value]) => value === currentReasoningEffort) && <option disabled value={currentReasoningEffort}>当前档位不受该模型支持</option>}
              {visibleEfforts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <SettingToggle checked={settings.appSettings.larkOwnerMentionAssistEnabled ?? false} disabled={saving || settings.larkSettingsKnown?.larkOwnerMentionAssistEnabled !== true} label="协同处理群里 @本人的消息" onChange={(checked) => void updateSetting({ larkOwnerMentionAssistEnabled: checked })} />
          {(settings.larkSettingsKnown?.larkOwnerMentionAssistEnabled !== true || settings.larkSettingsKnown?.larkOwnerMentionAssistOwnerId !== true) && <p className="subtle" role="status">群聊协同状态未知，当前 API / Agent 不可配置。</p>}
          <div className="settingsField">
            <label htmlFor="ownerMentionAssistOwnerId">被 @对象 open_id</label>
            <div className="inlineControl larkModelControl"><input id="ownerMentionAssistOwnerId" disabled={saving || settings.larkSettingsKnown?.larkOwnerMentionAssistOwnerId !== true} maxLength={200} value={ownerMentionAssistOwnerId} onChange={event => setOwnerMentionAssistOwnerId(event.target.value)} placeholder="留空使用审批接收人" />
              <button type="button" aria-label="保存协同对象" title="保存协同对象" disabled={saving || settings.larkSettingsKnown?.larkOwnerMentionAssistOwnerId !== true || !/^(?:ou_[A-Za-z0-9]+)?$/.test(ownerMentionAssistOwnerId.trim()) || ownerMentionAssistOwnerId.trim() === settings.appSettings.larkOwnerMentionAssistOwnerId} onClick={() => void updateSetting({ larkOwnerMentionAssistOwnerId: ownerMentionAssistOwnerId.trim() })}><Save size={16} /></button></div>
          </div>
          <SettingToggle checked={settings.appSettings.larkTopicNativeModeEnabled ?? false} disabled={saving || settings.larkSettingsKnown?.larkTopicNativeModeEnabled !== true} label="话题原生会话模式" onChange={(checked) => void updateSetting({ larkTopicNativeModeEnabled: checked })} />
          <SettingToggle checked={settings.appSettings.larkGroupSpontaneousRepliesEnabled} disabled={saving} label="允许 Agent 在群聊中随机加入对话" onChange={(checked) => void updateSetting({ larkGroupSpontaneousRepliesEnabled: checked })} />
          <div className="settingsField">
            <label htmlFor="spontaneousPercent">随机插话概率</label>
            <div className="inlineControl">
              <input id="spontaneousPercent" type="number" min={0} max={100} step={1} disabled={saving} value={spontaneousPercent} onChange={(event) => setSpontaneousPercent(event.target.value)} />
              <span>%</span>
              <button type="button" disabled={saving || !spontaneousPercent.trim() || !Number.isFinite(Number(spontaneousPercent)) || Number(spontaneousPercent) < 0 || Number(spontaneousPercent) > 100} onClick={() => void updateSetting({ larkGroupSpontaneousReplyRate: Number(spontaneousPercent) / 100 })}>保存概率</button>
            </div>
          </div>
          <div className="settingsField">
            <label htmlFor="spontaneousCooldownMinutes">随机插话冷却</label>
            <p className="subtle">机器人在同一群完成一次 @ 回复或随机插话后，冷却期内不再随机加入。0 表示关闭冷却。</p>
            <div className="inlineControl">
              <input id="spontaneousCooldownMinutes" type="number" min={0} max={10080} step={1} disabled={saving} value={spontaneousCooldownMinutes} onChange={(event) => setSpontaneousCooldownMinutes(event.target.value)} />
              <span>分钟</span>
              <button type="button" disabled={saving || !spontaneousCooldownMinutes.trim() || !Number.isFinite(Number(spontaneousCooldownMinutes)) || Number(spontaneousCooldownMinutes) < 0 || Number(spontaneousCooldownMinutes) > 10080} onClick={() => void updateSetting({ larkGroupSpontaneousReplyCooldownMs: Math.round(Number(spontaneousCooldownMinutes) * 60_000) })}>保存冷却</button>
            </div>
          </div>
          <div className="settingsField">
            <label htmlFor="spontaneousChatIds">自动插话群白名单（空名单禁止自动插话）</label>
            <textarea id="spontaneousChatIds" disabled={saving} rows={3} placeholder={"oc_群ID1\noc_群ID2"} value={spontaneousChatIds} onChange={(event) => setSpontaneousChatIds(event.target.value)} />
            <div className="inlineActions"><button disabled={saving} type="button" onClick={() => void updateSetting({ larkGroupSpontaneousChatIds: [...new Set(spontaneousChatIds.split(/[,，;；\s]+/).filter(Boolean))] })}>保存白名单</button></div>
          </div>
          <SettingToggle checked={settings.appSettings.larkTrustedExecutionEnabled} disabled={saving || !settings.larkCodexResponder.trustedExecutionConfigurable} label="允许可信发送人高权限执行" onChange={(checked) => void updateSetting({ larkTrustedExecutionEnabled: checked })} />
          {!settings.larkCodexResponder.trustedExecutionConfigurable && <p className="subtle">当前 Agent 未提供有效可信执行配置；请检查连接或更新 Agent 后再保存。</p>}
          <SettingToggle checked={settings.appSettings.larkTurnAutoApprovalEnabled} disabled={saving || !settings.larkCodexResponder.turnAutoApprovalConfigurable} label="自动审批当前任务" onChange={(checked) => void updateSetting({ larkTurnAutoApprovalEnabled: checked })} />
          <Link className="inlineLink" to="/approvals"><History size={15} />查看审批记录</Link>
          <div className="settingsField">
            <label htmlFor="deploymentAdapterPath">本机部署适配脚本（可选）</label>
            <div className="inlineControl"><input id="deploymentAdapterPath" disabled={saving} value={deploymentAdapterPath} onChange={(event) => setDeploymentAdapterPath(event.target.value)} placeholder="/absolute/path/to/deployment-adapter.mjs" /><button type="button" disabled={saving} title="保存部署适配脚本" aria-label="保存部署适配脚本" onClick={() => void updateSetting({ deploymentAdapterPath: deploymentAdapterPath.trim() })}><Save size={16} /></button></div>
          </div>
          <div className="settingsField">
            <label htmlFor="approvalDataSources">审批历史匹配的数据源</label>
            <textarea id="approvalDataSources" rows={3} disabled={saving || !settings.larkCodexResponder.turnAutoApprovalDataSourcesConfigurable} value={approvalDataSources} onChange={(event) => setApprovalDataSources(event.target.value)} placeholder={"analytics_demo\norders_demo"} />
            <p className="subtle">空名单不复用数据查询历史授权；未命中时仍由审批模型判断。此配置不授予数据访问权限。</p>
            <div className="inlineActions"><button type="button" aria-label="保存审批数据源" title="保存审批数据源" disabled={saving || !settings.larkCodexResponder.turnAutoApprovalDataSourcesConfigurable} onClick={() => void updateSetting({ larkTurnAutoApprovalDataSources: [...new Set(approvalDataSources.split(/[,，;；\s]+/).filter(Boolean).map(value => value.toLowerCase()))] })}><Save size={16} /></button></div>
          </div>
          <div className="settingsField">
            <label htmlFor={modelCatalog?.length ? "larkTurnAutoApprovalModel" : "customApprovalModel"}>审批模型</label>
            {Boolean(modelCatalog?.length) && <div className="inlineControl larkModelControl">
              <select
                id="larkTurnAutoApprovalModel"
                disabled={approvalModelDisabled}
                title={settings.larkCodexResponder.turnAutoApprovalModelConfigurable ? undefined : "需更新 Lark Agent 后使用"}
                value={showCustomApprovalModelInput ? "__custom__" : settings.appSettings.larkTurnAutoApprovalModel}
                onChange={(event) => {
                  const modelId = event.target.value;
                  if (modelId === "__custom__") { setCustomApprovalModelMode(true); return; }
                  setCustomApprovalModelMode(false);
                  setLarkTurnAutoApprovalModel(modelId);
                  void updateSetting({ larkTurnAutoApprovalModel: modelId });
                }}
              >
                {modelCatalog!.map((model) => <option key={model.id} value={model.id}>{model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`}</option>)}
                <option value="__custom__">自定义模型...</option>
              </select>
            </div>}
            {showCustomApprovalModelInput && <div className="inlineControl larkModelControl">
              <input aria-label="自定义审批模型 ID" id="customApprovalModel" type="text" maxLength={120} disabled={approvalModelDisabled} value={larkTurnAutoApprovalModel} onChange={(event) => setLarkTurnAutoApprovalModel(event.target.value)} placeholder="gpt-6.1-sol" />
              <button type="button" aria-label="保存审批模型" title="保存审批模型" disabled={approvalModelDisabled || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(larkTurnAutoApprovalModel.trim()) || larkTurnAutoApprovalModel.trim() === settings.appSettings.larkTurnAutoApprovalModel} onClick={() => void updateSetting({ larkTurnAutoApprovalModel: larkTurnAutoApprovalModel.trim() })}><Save size={16} /></button>
            </div>}
          </div>
        </div>}

        {settingsSection === "maintenance" && <div className="panel">
          <h3><Power size={16} /> 常驻启动</h3>
          <dl className="meta wide">
            <dt>状态</dt><dd>{!launchAgent?.supported ? "仅支持 macOS" : launchAgent.running ? "运行中" : launchAgent.installed ? "已安装" : "未安装"}</dd>
            <dt>服务</dt><dd>{launchAgent?.label || "-"}</dd>
            <dt>日志</dt><dd>{launchAgent?.logDirectory || "-"}</dd>
          </dl>
          <div className="inlineActions">
            <button disabled={saving || !launchAgent?.supported} onClick={() => void installLaunchAgent()} type="button"><Power size={15} /> {launchAgent?.installed ? "重新安装" : "安装"}</button>
            <button className="ghostButton" disabled={saving || !launchAgent?.installed} onClick={() => void restartLaunchAgent()} type="button"><RefreshCw size={15} /> 重启</button>
            <button className="dangerButton" disabled={saving || !launchAgent?.installed} onClick={() => setConfirmation({ title: "移除常驻服务", description: "这会停止并移除 Agent Forge 的 macOS 常驻启动项，但不会删除本机配置、待办或任务产物。", confirmLabel: "确认移除", destructive: true, onConfirm: uninstallLaunchAgent })} type="button"><Trash2 size={15} /> 移除</button>
          </div>
        </div>}

        {settingsSection === "maintenance" && <div className="panel">
          <h3><HardDrive size={16} /> 本地数据</h3>
          <dl className="meta wide">
            <dt>合计</dt><dd>{formatBytes(localData?.totalBytes ?? 0)}</dd>
            <dt>数据库</dt><dd>{formatBytes(localData?.databaseBytes ?? 0)}</dd>
            <dt>任务产物</dt><dd>{formatBytes(localData?.taskArtifactBytes ?? 0)}，{localData?.taskArtifactCount ?? 0} 个文件</dd>
            <dt>飞书附件</dt><dd>{formatBytes(localData?.larkArtifactBytes ?? 0)}，{localData?.larkArtifactCount ?? 0} 个任务</dd>
            <dt>常驻日志</dt><dd>{formatBytes(localData?.launchLogBytes ?? 0)}</dd>
          </dl>
          <div className="settingsField">
            <label htmlFor="retentionDays">保留天数</label>
            <div className="inlineControl"><input disabled={saving} id="retentionDays" max={3650} min={1} onChange={(event) => setRetentionDays(event.target.value)} type="number" value={retentionDays} /><span>天</span></div>
          </div>
          <div className="inlineActions">
            <button className="ghostButton" disabled={saving} onClick={() => setConfirmation({ title: "清理任务产物", description: `将永久清理 ${retentionDays} 天前已结束任务的产物，此操作无法恢复。`, confirmLabel: "确认清理", destructive: true, onConfirm: () => cleanupLocalData("completed-task-artifacts") })} type="button"><Trash2 size={15} /> 清理任务产物</button>
            <button className="ghostButton" disabled={saving} onClick={() => setConfirmation({ title: "清理常驻日志", description: `将永久清理 ${retentionDays} 天前的常驻服务日志，此操作无法恢复。`, confirmLabel: "确认清理", destructive: true, onConfirm: () => cleanupLocalData("launchd-logs") })} type="button"><Trash2 size={15} /> 清理日志</button>
          </div>
        </div>}

        {settingsSection === "maintenance" && <div className="panel">
          <h3><Download size={16} /> 备份与迁移</h3>
          <dl className="meta wide">
            <dt>导出范围</dt><dd>配置、仓库、待办、审计</dd>
            <dt>不含内容</dt><dd>token、飞书登录态、任务产物</dd>
          </dl>
          <input accept="application/json,.json" className="visuallyHidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void restoreBackup(file); }} ref={backupInputRef} type="file" />
          <div className="inlineActions">
            <button disabled={saving} onClick={() => void exportBackup()} type="button"><Download size={15} /> 导出</button>
            <button className="ghostButton" disabled={saving} onClick={() => backupInputRef.current?.click()} type="button"><Upload size={15} /> 导入</button>
          </div>
        </div>}

        {settingsSection === "maintenance" && <div className="panel">
          <h3><History size={16} /> 本地审计</h3>
          <div className="auditList">
            {auditEvents.map((event) => <div className="auditItem" key={event.id}><strong>{event.summary}</strong><span>{event.created_at.replace("T", " ").replace(/\.\d+Z$/, "")}</span></div>)}
            {auditEvents.length === 0 && <div className="emptyState small">尚无本地操作记录。</div>}
          </div>
        </div>}
      </div>
      {confirmation && <ConfirmDialog {...confirmation} onCancel={() => setConfirmation(null)} />}
    </section>
  );
}

function SettingToggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="toggleRow"><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span className="toggleTrack" aria-hidden="true" /><span><strong>{label}</strong></span></label>;
}
