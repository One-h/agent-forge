import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  ImagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { api, type LarkSticker, type LarkStickerUpload } from "../api";
import { DetailDrawer } from "../components/DetailDrawer";

const allowedMimeTypes = new Set<LarkStickerUpload["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp"
]);

const scenePresets = [
  { label: "无语吐槽", description: "面对离谱发言、荒唐结果或槽点时，用来表达无语和吐槽。", tags: ["无语", "吐槽"] },
  { label: "开心庆祝", description: "任务完成、结果不错或值得庆祝时，用来表达开心和认可。", tags: ["开心", "庆祝"] },
  { label: "生气反击", description: "需要强烈反驳、表达不满或回击挑衅时使用。", tags: ["生气", "反击"] },
  { label: "疑问震惊", description: "对意外信息、反常结果或难以理解的情况表示疑问和震惊。", tags: ["疑问", "震惊"] },
  { label: "拒绝否定", description: "明确拒绝提议、否定判断或表示不接受时使用。", tags: ["拒绝", "否定"] },
  { label: "催促等待", description: "催促推进、等待结果或提醒对方尽快处理时使用。", tags: ["催促", "等待"] },
  { label: "安慰鼓励", description: "对方受挫、任务失败或需要支持时，用来安慰和鼓励。", tags: ["安慰", "鼓励"] },
  { label: "完成交付", description: "工作完成、结果交付或确认收尾时使用。", tags: ["完成", "交付"] },
  { label: "报错失败", description: "执行失败、出现异常或需要说明任务未完成时使用。", tags: ["报错", "失败"] }
] as const;

type StatusFilter = "all" | "enabled" | "disabled";

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`读取 ${file.name} 失败`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error(`${file.name} 编码失败`));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function fileLabel(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").slice(0, 80) || "未命名表情包";
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mergeTags(current: string[], next: readonly string[]): string[] {
  return [...new Set([...current, ...next].map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function StickerCard({ sticker, onEdit }: { sticker: LarkSticker; onEdit: () => void }) {
  const shownTags = sticker.tags.slice(0, 3);

  return (
    <article className={`stickerCard ${sticker.enabled ? "" : "disabled"}`}>
      <button className="stickerCardOpen" type="button" onClick={onEdit} aria-label={`编辑 ${sticker.name}`}>
        <div className="stickerPreview">
          <img src={sticker.imageUrl} alt={sticker.name} loading="lazy" />
          <span className={`stickerStatus ${sticker.enabled ? "enabled" : "disabled"}`}>
            {sticker.enabled ? "已启用" : "已停用"}
          </span>
        </div>
        <div className="stickerCardBody">
          <div className="stickerCardTitle">
            <strong>{sticker.name}</strong>
            <Pencil size={14} />
          </div>
          <p>{sticker.description || "尚未填写适用场景"}</p>
          <div className="stickerTagList" aria-label="标签">
            {shownTags.length > 0 ? shownTags.map((tag) => <span key={tag}>{tag}</span>) : <span className="empty">未标记</span>}
            {sticker.tags.length > shownTags.length && <span>+{sticker.tags.length - shownTags.length}</span>}
          </div>
        </div>
      </button>
      <footer className="stickerCardMeta">
        <span>{formatBytes(sticker.sizeBytes)}</span>
        <span>使用 {sticker.usageCount} 次</span>
        {sticker.sourceSite && <span>{sticker.sourceSite}</span>}
      </footer>
    </article>
  );
}

function StickerEditor({
  sticker,
  onSaved,
  onRemoved,
  onClose
}: {
  sticker: LarkSticker;
  onSaved: (sticker: LarkSticker) => void;
  onRemoved: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(sticker.name);
  const [description, setDescription] = useState(sticker.description);
  const [tags, setTags] = useState(sticker.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [enabled, setEnabled] = useState(sticker.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addTag = () => {
    const next = tagDraft.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    if (next.length === 0) return;
    setTags((current) => mergeTags(current, next));
    setTagDraft("");
  };

  const applyScene = (preset: (typeof scenePresets)[number]) => {
    setDescription(preset.description);
    setTags((current) => mergeTags(current, preset.tags));
  };

  const save = async () => {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const updated = await api.updateLarkSticker(sticker.id, {
        name: name.trim(),
        description: description.trim(),
        tags,
        enabled
      });
      onSaved(updated);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`从表达资产库移除“${sticker.name}”？历史发送记录仍会保留。`)) return;
    setError("");
    try {
      await api.deleteLarkSticker(sticker.id);
      onRemoved(sticker.id);
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <DetailDrawer
      kicker="编辑表达资产"
      title={sticker.name}
      onClose={onClose}
      actions={<button className="primaryButton" type="button" disabled={saving} onClick={() => void save()}><Save size={15} />{saving ? "保存中" : "保存"}</button>}
    >
      <div className="stickerEditor">
        <div className="stickerEditorPreview"><img src={sticker.imageUrl} alt={sticker.name} /></div>

        <section className="stickerEditorSection">
          <div className="stickerEditorSectionTitle">
            <div><h3>基础信息</h3><p>名称会参与 Agent 召回，请写清画面表达。</p></div>
            <label className="stickerToggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />允许 Agent 使用</label>
          </div>
          <label className="stickerField">名称<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        </section>

        <section className="stickerEditorSection">
          <div className="stickerEditorSectionTitle"><div><h3>适用场景</h3><p>先选一个接近的场景，再按这张图的语气微调。</p></div></div>
          <div className="stickerPresetGrid">
            {scenePresets.map((preset) => (
              <button key={preset.label} type="button" onClick={() => applyScene(preset)}>{preset.label}</button>
            ))}
          </div>
          <label className="stickerField">场景描述<textarea value={description} maxLength={300} rows={4} placeholder="例如：对离谱发言表示无语，但语气偏调侃" onChange={(event) => setDescription(event.target.value)} /></label>
        </section>

        <section className="stickerEditorSection">
          <div className="stickerEditorSectionTitle"><div><h3>标签</h3><p>标签越具体，Agent 越容易在相近语境中选中它。</p></div></div>
          <div className="stickerEditableTags">
            {tags.length > 0 ? tags.map((tag) => (
              <button key={tag} type="button" title={`移除 ${tag}`} onClick={() => setTags((current) => current.filter((item) => item !== tag))}>{tag}<X size={12} /></button>
            )) : <span>还没有标签</span>}
          </div>
          <div className="stickerTagInput">
            <input
              value={tagDraft}
              maxLength={80}
              placeholder="输入标签，按 Enter 添加"
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "," || event.key === "，") {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
            <button className="ghostButton" type="button" disabled={!tagDraft.trim()} onClick={addTag}><Plus size={15} />添加</button>
          </div>
        </section>

        <section className="stickerEditorSection stickerAssetMeta">
          <div className="stickerEditorSectionTitle"><div><h3>资产信息</h3></div></div>
          <dl>
            <div><dt>格式</dt><dd>{sticker.mimeType}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(sticker.sizeBytes)}</dd></div>
            <div><dt>使用次数</dt><dd>{sticker.usageCount}</dd></div>
            <div><dt>资产 ID</dt><dd><code>{sticker.id}</code></dd></div>
          </dl>
          {sticker.sourceUrl && <a className="inlineLink" href={sticker.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />查看来源{sticker.sourceSite ? ` · ${sticker.sourceSite}` : ""}</a>}
        </section>

        {error && <div className="error compact">{error}</div>}
        <button className="ghostButton danger stickerRemoveButton" type="button" onClick={() => void remove()}><Trash2 size={15} />移除这项资产</button>
      </div>
    </DetailDrawer>
  );
}

export function StickerLibrary() {
  const [stickers, setStickers] = useState<LarkSticker[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedStickerId, setSelectedStickerId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(48);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => setStickers(await api.larkStickers());

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, []);

  const chooseFiles = (files: FileList | null) => {
    const next = [...(files ?? [])].slice(0, 20);
    const invalid = next.find((file) => !allowedMimeTypes.has(file.type as LarkStickerUpload["mimeType"]) || file.size > 2 * 1024 * 1024);
    if (invalid) {
      setError(`${invalid.name} 不是支持的图片格式或超过 2 MB`);
      return;
    }
    setError("");
    setSelectedFiles(next);
  };

  const upload = async () => {
    if (selectedFiles.length === 0) return;
    setUploading(true);
    setError("");
    try {
      const files: LarkStickerUpload[] = await Promise.all(selectedFiles.map(async (file) => ({
        name: fileLabel(file.name),
        description: "",
        tags: [],
        fileName: file.name,
        mimeType: file.type as LarkStickerUpload["mimeType"],
        dataBase64: await fileBase64(file)
      })));
      const created = await api.uploadLarkStickers(files);
      setStickers((current) => [...created, ...current]);
      setSelectedFiles([]);
      setFileInputKey((current) => current + 1);
      if (created[0]) setSelectedStickerId(created[0].id);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
    }
  };

  const popularTags = useMemo(() => {
    const counts = new Map<string, number>();
    stickers.forEach((sticker) => sticker.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN")).slice(0, 12);
  }, [stickers]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return stickers.filter((sticker) => {
      if (statusFilter === "enabled" && !sticker.enabled) return false;
      if (statusFilter === "disabled" && sticker.enabled) return false;
      if (tagFilter && !sticker.tags.includes(tagFilter)) return false;
      return !needle || [sticker.id, sticker.name, sticker.description, ...sticker.tags].some((value) => value.toLowerCase().includes(needle));
    });
  }, [query, statusFilter, stickers, tagFilter]);

  const visibleStickers = filtered.slice(0, visibleCount);
  const selectedSticker = stickers.find((sticker) => sticker.id === selectedStickerId) ?? null;

  useEffect(() => {
    setVisibleCount(48);
  }, [query, statusFilter, tagFilter]);

  return (
    <section className="pageStack">
      <div className="heroBand stickerHero">
        <div>
          <p className="eyebrow">表达资产</p>
          <h2>表情包库</h2>
          <p className="subtle">维护 Agent 可主动调用的表情包。用标签缩小范围，再在右侧面板中补充适用场景。</p>
        </div>
        <button className="ghostButton" type="button" onClick={() => void load().catch((err) => setError(String(err)))}><RefreshCw size={16} />刷新</button>
      </div>

      <section className="stickerUploadPanel">
        <div className="stickerUploadIcon"><ImagePlus size={24} /></div>
        <div className="stickerUploadCopy">
          <strong>批量添加表情包</strong>
          <span>PNG、JPG、GIF、WEBP 或 BMP；单张不超过 2 MB，每批最多 20 张。</span>
          {selectedFiles.length > 0 && <small>{selectedFiles.map((file) => file.name).join("、")}</small>}
        </div>
        <label className="ghostButton stickerFileButton">
          选择图片
          <input key={fileInputKey} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" onChange={(event) => chooseFiles(event.target.files)} />
        </label>
        <button className="primaryButton" type="button" disabled={uploading || selectedFiles.length === 0} onClick={() => void upload()}><Upload size={16} />{uploading ? "上传中" : `上传 ${selectedFiles.length || ""}`}</button>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="stickerFilterPanel" aria-label="筛选表达资产">
        <div className="stickerToolbar">
          <div className="searchBox stickerSearch"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、标签或场景" /></div>
          <div className="segmentedControl" aria-label="启用状态">
            {(["all", "enabled", "disabled"] as const).map((status) => (
              <button key={status} className={statusFilter === status ? "active" : ""} type="button" onClick={() => setStatusFilter(status)}>
                {{ all: "全部", enabled: "已启用", disabled: "已停用" }[status]}
              </button>
            ))}
          </div>
          <span className="stickerResultCount">显示 {filtered.length} / {stickers.length}</span>
        </div>
        <div className="stickerTagFilters" aria-label="常用标签">
          <button className={!tagFilter ? "active" : ""} type="button" onClick={() => setTagFilter("")}>全部标签</button>
          {popularTags.map(([tag, count]) => (
            <button key={tag} className={tagFilter === tag ? "active" : ""} type="button" onClick={() => setTagFilter((current) => current === tag ? "" : tag)}>{tag}<span>{count}</span></button>
          ))}
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="emptyState compact">没有符合当前筛选条件的表达资产。</div>
      ) : (
        <div className="stickerGrid">
          {visibleStickers.map((sticker) => <StickerCard key={sticker.id} sticker={sticker} onEdit={() => setSelectedStickerId(sticker.id)} />)}
        </div>
      )}
      {visibleCount < filtered.length && (
        <button className="ghostButton stickerLoadMore" type="button" onClick={() => setVisibleCount((current) => current + 48)}>
          再显示 48 张（剩余 {filtered.length - visibleCount}）
        </button>
      )}

      {selectedSticker && (
        <StickerEditor
          key={selectedSticker.id}
          sticker={selectedSticker}
          onClose={() => setSelectedStickerId(null)}
          onSaved={(updated) => setStickers((current) => current.map((item) => item.id === updated.id ? updated : item))}
          onRemoved={(id) => setStickers((current) => current.filter((item) => item.id !== id))}
        />
      )}
    </section>
  );
}
