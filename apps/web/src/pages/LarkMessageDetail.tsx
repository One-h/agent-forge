import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type LarkMessageArtifacts, type LarkMessageDetail, type LarkMessageFile, type LarkMessageImage } from "../api";
import { CodexEventTimeline } from "../components/CodexEventTimeline";
import { DetailDrawer } from "../components/DetailDrawer";
import { LarkExecutionConfigs } from "../components/LarkExecutionConfigs";
import { formatTime, statusText } from "../i18n";

function badgeClass(status: string): string {
  if (status === "answered" || status === "no_reply" || status === "sent") return "done";
  if (status === "failed" || status === "timeout") return "failed";
  if (status === "queued" || status === "running" || status === "pending") return "queued";
  return "blocked";
}

function senderLabel(message: LarkMessageDetail): string {
  if (message.sender_name) {
    return `${message.sender_name}${message.sender_enterprise_email ? ` · ${message.sender_enterprise_email}` : ""}`;
  }
  return message.sender_id
    || (message.senderType === "bot" ? "飞书机器人" : null)
    || "-";
}

function recipientLabel(message: LarkMessageDetail): string {
  return message.recipientName
    ? `${message.recipientName}${message.recipientId ? ` · ${message.recipientId}` : ""}`
    : message.recipientId || "-";
}

function outboundSourceText(source: string | null): string {
  if (source === "reply") return "回复发送";
  if (source === "proactive") return "主动发送";
  return "-";
}

function ArtifactBlock({ title, value }: { title: string; value: string | null }) {
  return (
    <article className="panel">
      <div className="sectionHeader compact">
        <h3>{title}</h3>
        <span className="muted">{value ? `${value.length} 个字符` : "空"}</span>
      </div>
      <pre className="log artifactLog">{value || "暂无输出。"}</pre>
    </article>
  );
}

function ImagePreviewBlock({ images }: { images: LarkMessageImage[] }) {
  if (images.length === 0) {
    return null;
  }
  return (
    <article className="panel">
      <div className="sectionHeader compact">
        <h3>消息图片</h3>
        <span className="muted">{images.length} 张</span>
      </div>
      <div className="larkImageGrid">
        {images.map((image) => (
          <figure className="larkImagePreview" key={image.path}>
            <img src={image.dataUrl} alt={image.name} />
            <figcaption title={image.path}>
              <span>{image.name}</span>
              <small>{image.mimeType}</small>
            </figcaption>
          </figure>
        ))}
      </div>
    </article>
  );
}

function FilePreviewBlock({ files }: { files: LarkMessageFile[] }) {
  if (files.length === 0) {
    return null;
  }
  return (
    <article className="panel">
      <div className="sectionHeader compact">
        <h3>消息文件</h3>
        <span className="muted">{files.length} 个</span>
      </div>
      <div className="larkFileStack">
        {files.map((file) => (
          <section className="larkFilePreview" key={file.path}>
            <div className="larkFileHeader" title={file.path}>
              <strong>{file.name}</strong>
              <span>{file.mimeType} · {file.size.toLocaleString("zh-CN")} 字节</span>
            </div>
            <pre className="log artifactLog">{file.text || "未提取到文本内容。"}</pre>
          </section>
        ))}
      </div>
    </article>
  );
}

export function LarkMessageDetailDrawer({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const [message, setMessage] = useState<LarkMessageDetail | null>(null);
  const [artifacts, setArtifacts] = useState<LarkMessageArtifacts | null>(null);
  const [images, setImages] = useState<LarkMessageImage[] | null>(null);
  const [files, setFiles] = useState<LarkMessageFile[] | null>(null);
  const [tab, setTab] = useState<"content" | "artifacts" | "media">("content");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setMessage(await api.larkMessage(messageId));
  }, [messageId]);

  const loadArtifacts = useCallback(async () => {
    setArtifacts(await api.larkMessageArtifacts(messageId));
  }, [messageId]);

  const loadMedia = useCallback(async () => {
    const [nextImages, nextFiles] = await Promise.all([api.larkMessageImages(messageId), api.larkMessageFiles(messageId)]);
    setImages(nextImages);
    setFiles(nextFiles);
  }, [messageId]);

  useEffect(() => {
    if (!Number.isFinite(messageId)) {
      return;
    }
    setMessage(null);
    setArtifacts(null);
    setImages(null);
    setFiles(null);
    setTab("content");
    setError("");
    void load().catch((err) => setError(String(err)));
  }, [load, messageId]);

  useEffect(() => {
    if (tab === "artifacts" && artifacts === null) {
      void loadArtifacts().catch((err) => setError(String(err)));
    }
    if (tab === "media" && (images === null || files === null)) {
      void loadMedia().catch((err) => setError(String(err)));
    }
  }, [artifacts, files, images, loadArtifacts, loadMedia, tab]);

  const shouldPoll = Boolean(message && (["pending", "queued", "running"].includes(message.reply_status) || ["queued", "running"].includes(message.codex_status)));
  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        void load().catch((err) => setError(String(err)));
        if (tab === "artifacts") void loadArtifacts().catch((err) => setError(String(err)));
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 5_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [load, loadArtifacts, shouldPoll, tab]);

  const refresh = () => {
    void load().catch((err) => setError(String(err)));
    if (tab === "artifacts") {
      void loadArtifacts().catch((err) => setError(String(err)));
    }
    if (tab === "media") {
      void loadMedia().catch((err) => setError(String(err)));
    }
  };

  if (!Number.isFinite(messageId)) {
    return (
      <DetailDrawer title="无效消息" onClose={onClose}>
        <div className="emptyState">消息 ID 无效。</div>
      </DetailDrawer>
    );
  }

  if (!message) {
    return (
      <DetailDrawer title="加载中" onClose={onClose}>
        <div className="emptyState">正在加载飞书消息详情。</div>
      </DetailDrawer>
    );
  }

  return (
    <DetailDrawer
      kicker="飞书 Codex 会话"
      title={`消息 #${message.id}`}
      onClose={onClose}
      actions={<button className="ghostButton" onClick={refresh}><RefreshCw size={16} /> 刷新</button>}
    >
      {error && <div className="error">{error}</div>}
      <div className="drawerStack">
        {message.direction === "inbound" && <div className="segmentedControl" aria-label="消息详情内容">
          <button className={tab === "content" ? "active" : ""} onClick={() => setTab("content")}>消息内容</button>
          <button className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>执行记录</button>
          <button className={tab === "media" ? "active" : ""} onClick={() => setTab("media")}>图片与附件</button>
        </div>}

        {tab === "content" && <>
          <section className="panel">
            <h3>消息信息</h3>
            <dl className="meta">
              <dt>方向</dt><dd><span className={`badge ${message.direction === "outbound" ? "open" : "neutral"}`}>{message.direction === "outbound" ? "出站" : "入站"}</span></dd>
              <dt>消息 ID</dt><dd className="mono">{message.message_id || "-"}</dd>
              <dt>引用消息</dt><dd className="mono">{message.reply_to_message_id || "-"}</dd>
              <dt>引用类型</dt><dd>{message.reply_to_message_type || "-"}</dd>
              <dt>事件 ID</dt><dd className="mono">{message.event_id || "-"}</dd>
              <dt>会话</dt><dd>{message.chat_type === "p2p" ? "单聊" : message.chat_type === "group" ? "群聊" : message.chat_type || "-"} {message.chat_id || ""}</dd>
              <dt>{message.chat_type === "group" ? "群聊 ID" : "飞书会话 ID"}</dt><dd className="mono">{message.chat_id || "-"}</dd>
              <dt>发送人</dt><dd>{senderLabel(message)}</dd>
              <dt>发送人 ID</dt><dd className="mono">{message.sender_id || "-"}</dd>
              <dt>发送人类型</dt><dd>{message.senderType || "-"}</dd>
              <dt>发送人部门</dt><dd>{message.sender_department || "-"}</dd>
              <dt>接收人</dt><dd>{recipientLabel(message)}</dd>
              <dt>接收人 ID</dt><dd className="mono">{message.recipientId || "-"}</dd>
              <dt>消息时间</dt><dd>{formatTime(message.messageAt || message.received_at)}</dd>
              {message.direction === "outbound" ? <>
                <dt>出站类型</dt><dd>{outboundSourceText(message.outboundSource)}</dd>
                <dt>投递状态</dt><dd><span className="badge done">已发送</span></dd>
              </> : <>
                <dt>是否提及</dt><dd>{message.mentioned ? "是" : "否"}</dd>
                {message.reply_trigger === "owner_mention" && <><dt>回复触发</dt><dd>@本人协同</dd></>}
                <dt>回复</dt><dd><span className={`badge ${badgeClass(message.reply_status)}`}>{statusText(message.reply_status)}</span></dd>
                <dt>错误</dt><dd>{message.reply_error || "-"}</dd>
              </>}
            </dl>
          </section>
          {message.direction === "inbound" && <section className="panel">
            <h3>Codex 信息</h3>
            <dl className="meta">
              <dt>状态</dt><dd><span className={`badge ${badgeClass(message.codex_status)}`}>{statusText(message.codex_status)}</span></dd>
              <dt>任务目录</dt><dd>{message.codex_task_dir || "-"}</dd>
              <dt>会话</dt><dd className="mono">{message.codex_session_id || "-"}</dd>
              <dt>开始时间</dt><dd>{formatTime(message.codex_started_at)}</dd>
              <dt>结束时间</dt><dd>{formatTime(message.codex_finished_at)}</dd>
              <dt>错误</dt><dd>{message.codex_error || "-"}</dd>
            </dl>
          </section>}
          {message.direction === "inbound" && <LarkExecutionConfigs configs={message.executionConfigs} />}
          <ArtifactBlock title="原始消息" value={message.content} />
          <ArtifactBlock title="引用消息" value={message.reply_to_content} />
          <ArtifactBlock title="引用原始 JSON" value={message.reply_to_raw_json ?? null} />
          {message.direction === "inbound" && <ArtifactBlock title="Codex 回复" value={message.codex_reply} />}
        </>}

        {message.direction === "inbound" && tab === "artifacts" && (artifacts ? <>
          <CodexEventTimeline approvals={artifacts.approvals} stdout={artifacts.stdout} />
          <ArtifactBlock title="提示词" value={artifacts.prompt} />
          <ArtifactBlock title="Codex 标准错误" value={artifacts.stderr} />
          {artifacts.tmuxCapture && <ArtifactBlock title="历史 tmux 输出" value={artifacts.tmuxCapture} />}
          <ArtifactBlock title="引用图片" value={artifacts.referencedImages} />
          <ArtifactBlock title="引用文件" value={artifacts.referencedFiles} />
          <ArtifactBlock title="图片下载错误" value={artifacts.imageDownloadError} />
          <ArtifactBlock title="文件下载错误" value={artifacts.fileDownloadError} />
          <ArtifactBlock title="可信发送人" value={artifacts.trustedSender} />
          <ArtifactBlock title="会话与 Turn" value={artifacts.resumeSession} />
          <ArtifactBlock title="Turn 结果" value={artifacts.turnResult} />
          <ArtifactBlock title="已发送媒体" value={artifacts.outboundMedia} />
          {artifacts.receipts.length > 0 && <ArtifactBlock title="执行回执" value={JSON.stringify(artifacts.receipts, null, 2)} />}
          {artifacts.deliveries.length > 0 && <ArtifactBlock title="媒体投递状态" value={JSON.stringify(artifacts.deliveries, null, 2)} />}
          {artifacts.launcher && <ArtifactBlock title="历史启动器" value={artifacts.launcher} />}
        </> : <div className="emptyState">正在加载执行记录。</div>)}

        {message.direction === "inbound" && tab === "media" && (images !== null && files !== null ? <>
          <ImagePreviewBlock images={images} />
          <FilePreviewBlock files={files} />
          {images.length === 0 && files.length === 0 && <div className="emptyState">此消息没有已下载的图片或附件。</div>}
        </> : <div className="emptyState">正在加载图片与附件。</div>)}
      </div>
    </DetailDrawer>
  );
}
