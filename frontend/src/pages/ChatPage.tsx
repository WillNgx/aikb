import { useState, useRef, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../api';
import type { ChatProgress as ChatProgressData } from '../api';
import { useNavigate } from 'react-router-dom';
import ChatMarkdown from '../components/ChatMarkdown';
import ChatProgress from '../components/ChatProgress';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  hasAnswer?: boolean;
  suggestions?: Suggestion[];
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

export default function ChatPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: t('chat.pageGreeting'),
      hasAnswer: true,
    },
  ]);
  const [input, setInput] = useState('');
  // Bước xử lý hiện tại do backend đẩy về qua SSE; null = vừa gửi, chưa nhận event nào.
  const [progress, setProgress] = useState<ChatProgressData | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  const chatMutation = useMutation({
    mutationFn: (question: string) => aiApi.chatStream(question, setProgress),
    onMutate: () => setProgress(null),
    onSettled: () => setProgress(null),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.answer,
          citations: data.citations,
          hasAnswer: data.hasAnswer,
          suggestions: data.suggestions,
          note: data.note,
        },
      ]);
    },
    onError: () => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: t('chat.pageError'),
          hasAnswer: false,
        },
      ]);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || chatMutation.isPending) return;

    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');
    chatMutation.mutate(question);
  };

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title">
          🤖 AI Chat
        </h1>
        <p className="page-subtitle">
          Hỏi bất kỳ điều gì — AI chỉ trả lời dựa trên Knowledge Base nội bộ
        </p>
      </div>

      <div className="chat-container">
        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i}>
              <div
                className={`chat-bubble ${msg.role === 'user' ? 'user' : msg.hasAnswer === false ? 'no-answer' : 'assistant'}`}
              >
                {msg.role === 'assistant' && (
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.375rem', opacity: 0.7 }}>
                    🤖 Trợ lý AI
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <ChatMarkdown content={msg.content} />
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                )}

                {/* Cảnh báo: chưa có nội dung gắn riêng cho Provider đã hỏi */}
                {msg.note && (
                  <div
                    className="alert-box alert-warning"
                    style={{ marginTop: '0.75rem', fontSize: '0.8125rem' }}
                  >
                    {msg.note}
                  </div>
                )}

                {/* Citations */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="citation-list" style={{ marginTop: '0.75rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '0.25rem' }}>
                      📚 Nguồn tham khảo:
                    </div>
                    {msg.citations.map((c, ci) => (
                      <button
                        key={ci}
                        className="citation-item"
                        onClick={() => {
                          const hash =
                            c.headingIndex !== null && c.headingIndex !== undefined
                              ? `#heading-${c.headingIndex}`
                              : '';
                          navigate(`/wiki/${c.contentId}${hash}`);
                        }}
                        title={c.excerpt}
                      >
                        🔗 {c.contentTitle}{c.sectionTitle ? ` › ${c.sectionTitle}` : ''}
                      </button>
                    ))}
                  </div>
                )}

                {/* No-answer suggestions */}
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '0.375rem' }}>
                      💡 Bạn có thể tham khảo:
                    </div>
                    {msg.suggestions.map((s, si) => (
                      <button
                        key={si}
                        className="citation-item"
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
            <div className="chat-bubble assistant">
              <ChatProgress progress={progress} />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form className="chat-input-area" onSubmit={handleSubmit}>
          <textarea
            id="chat-input"
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('chat.pageInputPlaceholder')}
            rows={1}
            style={{ maxHeight: '120px' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
          />
          <button
            id="btn-send-chat"
            type="submit"
            className="btn-primary-custom"
            disabled={chatMutation.isPending || !input.trim()}
            style={{ padding: '0.625rem 1.25rem', whiteSpace: 'nowrap' }}
          >
            Gửi ↑
          </button>
        </form>
      </div>
    </div>
  );
}
