import ReactMarkdown from 'react-markdown';

interface ChatMarkdownProps {
  content: string;
}

/** Render nội dung câu trả lời AI (Markdown do Gemini trả về: **bold**, ## heading, danh sách...)
 * thành định dạng thật thay vì hiện nguyên ký tự thô. Dùng chung cho ChatPage và AIChatWidget. */
export default function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
