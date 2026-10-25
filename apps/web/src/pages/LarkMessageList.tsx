import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, MessageSquareText, RefreshCw, Search, UserRound, X, SlidersHorizontal } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type LarkConversation, type LarkMessageListItem } from "../api";
import { formatTime } from "../i18n";
import { usePersistentState } from "../usePersistentState";
import { LarkMessageDetailDrawer } from "./LarkMessageDetail";
import { CopyableId } from "../components/CopyableId";
import { LarkPersonaDrawer } from "./LarkPersonaDrawer";

const conversationLimit = 100;
const messagePageLimit = 50;

function initials(contact: LarkConversation): string {
  const value = contact.contactName?.trim() || contact.contactId;
  return [...value].slice(0, 2).join("").toUpperCase();
}

function contactTitle(contact: LarkConversation): string {
  if (contact.chatType === "group") return contact.contactName || contact.contactId;
  return contact.contactName || contact.contactId;
}

function messageText(message: LarkMessageListItem): string {
  return message.content || `[${message.message_type || "消息"}]`;
}

function outboundSourceText(source: string | null): string {
  if (source === "reply") return "回复发送";
  if (source === "proactive") return "主动发送";
  return "已发送";
}

function clockTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}

function dateKey(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return `${parsed.getFullYear()}-${parsed.getMonth() + 1}-${parsed.getDate()}`;
}

function dateLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(parsed);
}

function sortMessages(items: LarkMessageListItem[]): LarkMessageListItem[] {
  return [...new Map(items.map((message) => [message.id, message])).values()]
    .sort((left, right) => left.messageAt.localeCompare(right.messageAt) || left.id - right.id);
}

function ConversationSkeleton() {
  return (
    <div className="conversationSkeletonList" aria-label="会话加载中" aria-busy="true">
      {[0, 1, 2, 3, 4].map((item) => (
        <div className="conversationSkeletonRow" key={item} aria-hidden="true">
          <span className="skeletonBlock skeletonAvatar" />
          <span className="conversationSkeletonText">
            <span className="skeletonBlock skeletonLine strong" />
            <span className="skeletonBlock skeletonLine" />
          </span>
        </div>
      ))}
    </div>
  );
}

function MessageSkeleton() {
  return (
    <div className="messageSkeleton" aria-label="聊天记录加载中" aria-busy="true">
      {["inbound", "outbound", "inbound", "outbound"].map((direction, index) => (
        <span className={`skeletonBlock messageSkeletonBubble ${direction}`} key={`${direction}-${index}`} aria-hidden="true" />
      ))}
    </div>
  );
}

export function LarkMessageList() {
  const navigate = useNavigate();
  const { messageId: messageIdParam } = useParams();
  const selectedMessageId = messageIdParam ? Number(messageIdParam) : null;
  const [query, setQuery] = usePersistentState("autofix.lark.conversationQuery", "");
  const [chatType, setChatType] = usePersistentState<"p2p" | "group">("autofix.lark.conversationType", "p2p");
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim());
  const [contacts, setContacts] = useState<LarkConversation[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsLoadingMore, setContactsLoadingMore] = useState(false);
  const [contactsError, setContactsError] = useState("");
  const [contactsMoreError, setContactsMoreError] = useState("");
  const [contactTotal, setContactTotal] = useState(0);
  const [contactsHaveMore, setContactsHaveMore] = useState(false);
  const [namesRefreshing, setNamesRefreshing] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [personaChat, setPersonaChat] = useState<{ chatId: string; chatType: "group" | "p2p"; title: string } | null>(null);
  const [messages, setMessages] = useState<LarkMessageListItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const contactsRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const shouldScrollToBottomRef = useRef(false);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.contactId === selectedContactId) ?? null,
    [contacts, selectedContactId]
  );

  const groupedMessages = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: LarkMessageListItem[] }> = [];
    for (const message of messages) {
      const key = dateKey(message.messageAt);
      const current = groups.at(-1);
      if (!current || current.key !== key) groups.push({ key, label: dateLabel(message.messageAt), items: [message] });
      else current.items.push(message);
    }
    return groups;
  }, [messages]);

  const loadContacts = useCallback(async (offset = 0) => {
    const requestId = ++contactsRequestRef.current;
    if (offset === 0) {
      setContactsLoading(true);
      setContactsLoadingMore(false);
    }
    else setContactsLoadingMore(true);
    if (offset === 0) {
      setContactsError("");
      setContactsMoreError("");
    } else {
      setContactsMoreError("");
    }
    try {
      const response = await api.larkConversations({ keyword: debouncedQuery || undefined, limit: conversationLimit, offset, chatType });
      if (requestId !== contactsRequestRef.current) return;
      setNamesRefreshing(response.namesRefreshing === true);
      setContactTotal(response.pagination.total);
      setContactsHaveMore(response.pagination.hasMore);
      if (offset === 0) {
        const nextContacts = [...response.items].sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
        setContacts(nextContacts);
        setSelectedContactId((selected) => nextContacts.some((contact) => contact.contactId === selected) ? selected : nextContacts[0]?.contactId ?? "");
      } else {
        setContacts((current) => [...new Map([...current, ...response.items].map((contact) => [contact.contactId, contact])).values()]
          .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)));
      }
    } catch (error) {
      if (requestId === contactsRequestRef.current) {
        setNamesRefreshing(false);
        if (offset === 0) setContactsError(String(error));
        else setContactsMoreError(String(error));
      }
    } finally {
      if (requestId === contactsRequestRef.current) {
        setContactsLoading(false);
        setContactsLoadingMore(false);
      }
    }
  }, [debouncedQuery, chatType]);

  const loadMessages = useCallback(async (contactId: string) => {
    const requestId = ++messagesRequestRef.current;
    setMessagesLoading(true);
    setLoadingEarlier(false);
    setMessagesError("");
    setMessages([]);
    setHasMore(false);
    setNextCursor(undefined);
    try {
      const response = await api.larkConversationMessages(contactId, { limit: messagePageLimit });
      if (requestId !== messagesRequestRef.current) return;
      setMessages(sortMessages(response.items));
      setHasMore(response.pagination.hasMore);
      setNextCursor(response.pagination.nextCursor);
      shouldScrollToBottomRef.current = true;
    } catch (error) {
      if (requestId === messagesRequestRef.current) setMessagesError(String(error));
    } finally {
      if (requestId === messagesRequestRef.current) setMessagesLoading(false);
    }
  }, []);

  const loadEarlier = useCallback(async () => {
    if (!selectedContactId || !hasMore || !nextCursor || loadingEarlier) return;
    const requestId = messagesRequestRef.current;
    const timeline = timelineRef.current;
    const previousHeight = timeline?.scrollHeight ?? 0;
    setLoadingEarlier(true);
    setMessagesError("");
    try {
      const response = await api.larkConversationMessages(selectedContactId, { cursor: nextCursor, limit: messagePageLimit });
      if (requestId !== messagesRequestRef.current) return;
      setMessages((current) => sortMessages([...response.items, ...current]));
      setHasMore(response.pagination.hasMore);
      setNextCursor(response.pagination.nextCursor);
      window.requestAnimationFrame(() => {
        if (timeline) timeline.scrollTop += timeline.scrollHeight - previousHeight;
      });
    } catch (error) {
      if (requestId === messagesRequestRef.current) setMessagesError(String(error));
    } finally {
      if (requestId === messagesRequestRef.current) setLoadingEarlier(false);
    }
  }, [hasMore, loadingEarlier, nextCursor, selectedContactId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => { void loadContacts(); }, [loadContacts]);
  useEffect(() => {
    if (!namesRefreshing) return;
    const timer = window.setInterval(() => { void loadContacts(); }, 2000);
    return () => window.clearInterval(timer);
  }, [namesRefreshing, loadContacts]);

  useEffect(() => {
    if (!selectedContactId) {
      messagesRequestRef.current += 1;
      setMessages([]);
      setMessagesLoading(false);
      setLoadingEarlier(false);
      setMessagesError("");
      return;
    }
    void loadMessages(selectedContactId);
  }, [loadMessages, selectedContactId]);

  useEffect(() => {
    if (!shouldScrollToBottomRef.current || messagesLoading) return;
    shouldScrollToBottomRef.current = false;
    window.requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
  }, [messages, messagesLoading]);

  const refresh = () => {
    void loadContacts();
    if (selectedContactId) void loadMessages(selectedContactId);
  };

  const switchChatType = (next: "p2p" | "group") => {
    if (next === chatType) return;
    contactsRequestRef.current += 1;
    messagesRequestRef.current += 1;
    setContacts([]);
    setSelectedContactId("");
    setMessages([]);
    setQuery("");
    setDebouncedQuery("");
    setChatType(next);
  };

  return (
    <section className="pageStack larkConversationPage">
      <div className="heroBand conversationHero">
        <div>
          <p className="eyebrow">飞书接入</p>
          <h2>飞书消息</h2>
        </div>
        <button className="ghostButton" type="button" onClick={refresh}><RefreshCw size={16} /> 刷新记录</button>
      </div>

      <div className="conversationWorkspace">
        <aside className="conversationMaster" aria-label="会话列表">
          <div className="conversationMasterHeader">
            <div><h3>{chatType === "group" ? "群聊" : "联系人"}</h3><span>{contactTotal || contacts.length} 个会话</span></div>
            <div className="segmentedControl" aria-label="会话类型">
              <button type="button" aria-pressed={chatType === "p2p"} className={chatType === "p2p" ? "active" : ""} onClick={() => switchChatType("p2p")}>单聊</button>
              <button type="button" aria-pressed={chatType === "group"} className={chatType === "group" ? "active" : ""} onClick={() => switchChatType("group")}>群聊</button>
            </div>
            <label className="conversationSearch">
              <span className="visuallyHidden">搜索会话</span>
              <Search size={16} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={chatType === "group" ? "搜索群名称或群聊 ID" : "搜索姓名、人员或会话 ID"} />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="清空会话搜索"><X size={14} /></button>}
            </label>
          </div>

          {contactsLoading && contacts.length === 0 ? <ConversationSkeleton /> : contactsError ? (
            <div className="conversationState errorState" role="alert">
              <strong>会话加载失败</strong><span>{contactsError}</span>
              <button className="ghostButton" type="button" onClick={() => void loadContacts()}><RefreshCw size={15} /> 重试</button>
            </div>
          ) : contacts.length === 0 ? (
            <div className="conversationState">
              <UserRound size={28} aria-hidden="true" />
              <strong>{debouncedQuery ? "没有匹配的会话" : "暂无聊天记录"}</strong>
            </div>
          ) : (
            <div className="conversationList">
              {contacts.map((contact) => (
                <button className={`conversationContact ${contact.contactId === selectedContactId ? "active" : ""}`} type="button" key={contact.contactId} onClick={() => setSelectedContactId(contact.contactId)} aria-current={contact.contactId === selectedContactId ? "true" : undefined}>
                  <span className="conversationAvatar" aria-hidden="true">{initials(contact)}</span>
                  <span className="conversationContactBody">
                    <span className="conversationContactTop"><strong>{contactTitle(contact)}</strong><time dateTime={contact.lastMessageAt}>{formatTime(contact.lastMessageAt)}</time></span>
                    <span className="conversationContactBottom"><span>{contact.lastMessagePreview || "暂无文本摘要"}</span><b aria-label={`${contact.messageCount} 条消息`}>{contact.messageCount}</b></span>
                  </span>
                </button>
              ))}
              {contactsHaveMore && !contactsMoreError && <div className="conversationLoadMore">
                <button className="ghostButton" type="button" disabled={contactsLoadingMore} onClick={() => void loadContacts(contacts.length)}>
                  {contactsLoadingMore ? "正在加载…" : "加载更多会话"}
                </button>
              </div>}
              {contactsMoreError && <div className="conversationInlineError contactLoadError" role="alert">
                <span>{contactsMoreError}</span>
                <button type="button" onClick={() => void loadContacts(contacts.length)}>重试加载</button>
              </div>}
            </div>
          )}
        </aside>

        <section className="conversationDetail" aria-label="聊天记录">
          {selectedContact ? (
            <header className="conversationDetailHeader">
              <span className="conversationAvatar large" aria-hidden="true">{initials(selectedContact)}</span>
              <span className="conversationHeaderInfo"><h3>{contactTitle(selectedContact)}</h3><small>{selectedContact.messageCount} 条消息 · {selectedContact.inboundCount} 入站 · {selectedContact.outboundCount} 出站</small>
                {selectedContact.chatId && <CopyableId label={chatType === "group" ? "群聊 ID" : "飞书会话 ID"} value={selectedContact.chatId} />}
                {chatType === "p2p" && <CopyableId label="人员 ID" value={selectedContact.contactId} />}
                {(selectedContact.codexSessionIds ?? []).map((id) => <CopyableId key={id} label="Codex 会话 ID" value={id} />)}
              </span>
              <button type="button" className="ghostButton personaOpenButton" disabled={!selectedContact.chatId} onClick={() => selectedContact.chatId && setPersonaChat({ chatId: selectedContact.chatId, chatType, title: contactTitle(selectedContact) })}><SlidersHorizontal size={15} /> 设置</button>
            </header>
          ) : <div className="conversationDetailHeader placeholder"><span>聊天记录</span></div>}

          <div className="conversationTimeline" ref={timelineRef} aria-busy={messagesLoading}>
            {messagesLoading ? <MessageSkeleton /> : messagesError && messages.length === 0 ? (
              <div className="conversationState errorState" role="alert">
                <strong>聊天记录加载失败</strong><span>{messagesError}</span>
                <button className="ghostButton" type="button" onClick={() => selectedContactId && void loadMessages(selectedContactId)}><RefreshCw size={15} /> 重试</button>
              </div>
            ) : !selectedContact ? (
              <div className="conversationState"><MessageSquareText size={30} aria-hidden="true" /><strong>选择一个会话</strong></div>
            ) : messages.length === 0 ? (
              <div className="conversationState"><MessageSquareText size={30} aria-hidden="true" /><strong>没有可显示的消息</strong></div>
            ) : <>
              <div className="loadEarlierRow">
                {hasMore && <button className="ghostButton" type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}><ArrowUp size={15} /> {loadingEarlier ? "正在加载…" : "加载更早消息"}</button>}
              </div>
              {messagesError && <div className="conversationInlineError" role="alert"><span>{messagesError}</span><button type="button" onClick={() => void loadEarlier()}>重试加载</button></div>}
              {groupedMessages.map((group) => (
                <section className="messageDay" key={group.key} aria-label={group.label}>
                  <div className="messageDayLabel"><span>{group.label}</span></div>
                  {group.items.map((message) => (
                    <div className={`messageBubbleRow ${message.direction}`} key={message.id}>
                      <div className="messageEnvelope">
                      <span className="messageAuthor">{message.direction === "outbound" ? `机器人 → ${message.recipientName || message.recipientId || "当前会话"}` : message.sender_name || message.sender_id || "未知发送人"}</span>
                      <button className="messageBubble" type="button" onClick={() => navigate(`/lark-messages/${message.id}`)} aria-label={`${message.direction === "outbound" ? "出站" : "入站"}消息，${clockTime(message.messageAt)}，打开详情`}>
                        <span className="messageDirection">{message.direction === "outbound" ? "出站" : "入站"}</span>
                        <span className="messageBody">{messageText(message)}</span>
                        <span className="messageMeta">{message.direction === "outbound" && <span>{outboundSourceText(message.outboundSource)}</span>}<time dateTime={message.messageAt}>{clockTime(message.messageAt)}</time></span>
                      </button>
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </>}
          </div>
        </section>
      </div>

      {selectedMessageId !== null && <LarkMessageDetailDrawer messageId={selectedMessageId} onClose={() => navigate("/lark-messages")} />}
      {personaChat && <LarkPersonaDrawer key={personaChat.chatId} chatId={personaChat.chatId} chatType={personaChat.chatType} title={personaChat.title} onClose={() => setPersonaChat(null)} onSessionReset={() => void loadContacts()} />}
    </section>
  );
}
