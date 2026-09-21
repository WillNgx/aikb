import { useState, useRef, useEffect } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { aiApi } from "../api";
import type { ChatProgress as ChatProgressData } from "../api";
import { useNavigate } from "react-router-dom";
import ChatMarkdown from "./ChatMarkdown";
import ChatProgress from "./ChatProgress";

interface ClarificationOption {
  label: string;
  provider: string;
  query: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  hasAnswer?: boolean;
  suggestions?: Suggestion[];
  needsClarification?: boolean;
  clarificationOptions?: ClarificationOption[];
  note?: string;
}

interface Citation {
  chunkId: string;
  contentId: string;
  contentTitle: string;
  sectionTitle: string | null;
  headingIndex: number | null;
  excerpt: string;
}

interface Suggestion {
  contentId: string;
  contentTitle: string;
  sectionTitle: string | null;
  excerpt: string;
}

export default function AIChatWidget() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: t("chat.greeting"),
      hasAnswer: true,
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Bước xử lý hiện tại do backend đẩy về qua SSE; null = vừa gửi, chưa nhận event nào.
  const [progress, setProgress] = useState<ChatProgressData | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen && !isMinimized) {
      scrollToBottom();
    }
  }, [messages, isOpen, isMinimized]);

  const chatMutation = useMutation({
    mutationFn: (question: string) => aiApi.chatStream(question, setProgress),
    onMutate: () => setProgress(null),
    onSettled: () => setProgress(null),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          citations: data.citations,
          hasAnswer: data.hasAnswer,
          suggestions: data.suggestions,
          needsClarification: data.needsClarification,
          clarificationOptions: data.clarificationOptions,
          note: data.note,
        },
      ]);
    },
    onError: (err: any) => {
      // [FIX] Không được tự bịa câu trả lời khi API lỗi — báo lỗi rõ ràng cho user
      // thay vì hiển thị nội dung giả mạo như thể AI vừa trả lời thật.
      const status = err?.response?.status;
      // Axios tự hủy request khi vượt timeout — lúc này KHÔNG có response, nên phải nhận diện
      // riêng, nếu không user sẽ thấy nhầm là "mất kết nối mạng" trong khi server vẫn đang chạy.
      const isClientTimeout =
        err?.code === "ECONNABORTED" || /timeout/i.test(err?.message ?? "");

      let errorText: string;
      if (status === 429) {
        errorText = t("chat.errorRateLimited");
      } else if (status === 503) {
        errorText = t("chat.errorBusy");
      } else if (isClientTimeout) {
        errorText = t("chat.errorTimeout");
      } else {
        errorText = err?.response?.data?.error || t("chat.errorOffline");
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `⚠️ ${errorText}`,
          hasAnswer: false,
        },
      ]);
    },
  });

  const handleSend = (textToSend?: string) => {
    const question = (textToSend || input).trim();
    if (!question || chatMutation.isPending) return;

    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    chatMutation.mutate(question);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleSend();
  };

  const handleClearHistory = () => {
    setMessages([
      {
        role: "assistant",
        content: t("chat.cleared"),
        hasAnswer: true,
      },
    ]);
  };

  return (
    <>
      {/* Floating Toggle Button (FAB) */}
      {!isOpen && (
        <button
          className="ai-chat-fab"
          onClick={() => {
            setIsOpen(true);
            setIsMinimized(false);
          }}
          title={t("chat.openTitle")}
          aria-label="AI Chat"
        >
          <div className="fab-pulse" />
          <span className="fab-icon">🤖</span>
          <span className="fab-text">{t("chat.askAi")}</span>
          <span className="fab-status-dot" />
        </button>
      )}

      {/* Floating Chat Popup Window */}
      {isOpen && (
        <div className={`ai-chat-popup ${isMinimized ? "minimized" : ""}`}>
          {/* Header */}
          <div className="chat-popup-header">
            <div
              className="chat-popup-title"
              onClick={() => setIsMinimized(!isMinimized)}
            >
              <span className="chat-bot-avatar">🤖</span>
              <div>
                <div className="chat-title-text">{t("chat.title")}</div>
                <div className="chat-status-text">
                  <span className="online-indicator" /> {t("chat.status")}
                </div>
              </div>
            </div>
            <div className="chat-popup-actions">
              <button
                className="popup-btn"
                title={t("chat.refresh")}
                aria-label={t("chat.refresh")}
                onClick={handleClearHistory}
              >
                🔄
              </button>
              <button
                className="popup-btn"
                title={isMinimized ? t("chat.expand") : t("chat.minimize")}
                onClick={() => setIsMinimized(!isMinimized)}
              >
                {isMinimized ? "▲" : "▼"}
              </button>
              <button
                className="popup-btn close-btn"
                title={t("chat.closeChat")}
                onClick={() => setIsOpen(false)}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Body (hidden when minimized) */}
          {!isMinimized && (
            <>
              {/* Messages Area */}
              <div className="chat-popup-body">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`chat-popup-message ${msg.role === "user" ? "user" : "assistant"}`}
                  >
                    {msg.role === "assistant" && (
                      <div className="msg-avatar">🤖</div>
                    )}
                    <div className="msg-content-wrapper">
                      <div className="msg-bubble">
                        {msg.role === "assistant" ? (
                          <ChatMarkdown content={msg.content} />
                        ) : (
                          <div style={{ whiteSpace: "pre-wrap" }}>
                            {msg.content}
                          </div>
                        )}
                      </div>

                      {/* Cảnh báo: chưa có nội dung gắn riêng cho Provider đã hỏi */}
                      {msg.note && (
                        <div className="alert-box alert-warning" style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
                          {msg.note}
                        </div>
                      )}

                      {/* Citations */}
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="chat-citations">
                          <div className="citations-label">
                            📚 {t("chat.citations")}
                          </div>
                          {msg.citations.map((c, ci) => (
                            <button
                              key={ci}
                              className="citation-chip"
                              onClick={() => {
                                const hash =
                                  c.headingIndex !== null && c.headingIndex !== undefined
                                    ? `#heading-${c.headingIndex}`
                                    : "";
                                navigate(`/wiki/${c.contentId}${hash}`);
                              }}
                              title={c.excerpt}
                            >
                              🔗 {c.contentTitle}{" "}
                              {c.sectionTitle ? `› ${c.sectionTitle}` : ""}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Clarification Action Chips (Rủi ro 1) */}
                      {msg.needsClarification &&
                        msg.clarificationOptions &&
                        msg.clarificationOptions.length > 0 && (
                          <div className="clarification-chips-wrapper">
                            <div className="clarification-label">
                              👉 {t("chat.clarifyProvider")}
                            </div>
                            <div className="clarification-chips">
                              {msg.clarificationOptions.map((opt, oi) => (
                                <button
                                  key={oi}
                                  className="clarification-chip-btn"
                                  onClick={() => handleSend(opt.query)}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                      {/* Suggestions */}
                      {msg.suggestions && msg.suggestions.length > 0 && (
                        <div className="chat-citations">
                          <div className="citations-label">
                            💡 {t("chat.suggestions")}
                          </div>
                          {msg.suggestions.map((s, si) => (
                            <button
                              key={si}
                              className="citation-chip"
                              onClick={() => navigate(`/wiki/${s.contentId}`)}
                            >
                              📄 {s.contentTitle}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {chatMutation.isPending && (
                  <div className="chat-popup-message assistant">
                    <div className="msg-avatar">🤖</div>
                    <div className="msg-bubble loading-bubble">
                      <ChatProgress progress={progress} />
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <form className="chat-popup-footer" onSubmit={handleSubmit}>
                <input
                  type="text"
                  className="chat-popup-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t("chat.inputPlaceholder")}
                  disabled={chatMutation.isPending}
                />
                <button
                  type="submit"
                  className="chat-popup-send"
                  disabled={chatMutation.isPending || !input.trim()}
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                >
                  ➤
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}
