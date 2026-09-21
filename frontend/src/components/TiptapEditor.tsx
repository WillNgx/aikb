import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import type { Editor } from '@tiptap/react';
import TiptapToolbar from './TiptapToolbar';
import { useAlert } from './ConfirmModal';
import Callout from '../extensions/Callout';
import HeadingAnchor from '../extensions/HeadingAnchor';
import TableHeaderColor from '../extensions/TableHeaderColor';
import { uploadImageFile, uploadImageFromUrl } from '../utils/uploadImageFile';
import { createEmptyDoc } from '../data/docModel';
import type { TiptapDoc } from '../data/docModel';

interface TiptapEditorProps {
  value: TiptapDoc | null | undefined;
  onChange: (doc: TiptapDoc) => void;
  // true = đang Chỉnh sửa (hiện toolbar + gõ được), false = chỉ đọc (trang tài liệu tĩnh)
  editable: boolean;
  onEditorReady?: (editor: Editor) => void;
  placeholder?: string;
}

function normalizeForEditor(value: TiptapDoc | null | undefined): TiptapDoc {
  return value && Array.isArray(value.content) && value.content.length > 0 ? value : createEmptyDoc();
}

export default function TiptapEditor({
  value,
  onChange,
  editable,
  onEditorReady,
  placeholder,
}: TiptapEditorProps) {
  const thongBao = useAlert();
  const { t } = useTranslation();
  const placeholderText = placeholder ?? t('editor.contentPlaceholder');
  const editor = useEditor({
    extensions: [
      // link/underline: tắt bản StarterKit tự bundle sẵn (Tiptap v3) — dùng bản import riêng
      // bên dưới để tuỳ chỉnh (Link.openOnClick=false, autolink=true), tránh đăng ký trùng tên.
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, underline: false }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Underline,
      Placeholder.configure({ placeholder: placeholderText }),
      // Dán 1 đường dẫn http(s) → tự động gắn thành link bấm được — không mở link khi click
      // trong lúc đang soạn thảo.
      Link.configure({ openOnClick: false, autolink: true }),
      Image,
      // cellMinWidth mặc định của TipTap là 25px. Với bảng nhiều cột (bảng hạn mức cược có
      // tới 7 cột) thì mỗi ô chỉ còn ~79px, chữ bị bẻ giữa từ ("Roulett / e: 15 VND") và
      // KHÔNG cuộn ngang được, vì TipTap tự ghi inline style `min-width` lên thẻ <table>
      // bằng tổng min-width các cột — inline style đè mọi rule CSS thường, nên phải chỉnh
      // ở đây chứ không phải trong index.css.
      // 110px đủ chỗ cho một cụm như "Blackjack: 100 VND" trên 2 dòng thay vì 5.
      Table.configure({ resizable: true, cellMinWidth: 110 }),
      TableRow,
      TableHeaderColor,
      TableCell,
      Callout,
      HeadingAnchor,
    ],
    content: normalizeForEditor(value),
    editable,
    editorProps: {
      attributes: { class: 'tiptap-prosemirror' },
      handlePaste: (view, event) => {
        // Ảnh dán trực tiếp từ clipboard (không phải HTML/URL) → upload rồi chèn thẳng vào vị
        // trí con trỏ. Bảng dán từ Excel/Google Sheets kèm HTML <table> được ProseMirror tự
        // parse thành node Table đúng schema (Table/TableRow/TableCell đã đăng ký) — không cần
        // xử lý thủ công.
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        const insertUploadedImage = (uploadPromise: Promise<string>) => {
          uploadPromise
            .then((url) => {
              const imageType = view.state.schema.nodes.image;
              if (!imageType) return;
              const tr = view.state.tr.replaceSelectionWith(imageType.create({ src: url }));
              view.dispatch(tr);
            })
            .catch((err: Error) => thongBao(err.message));
        };

        const imageFile = Array.from(clipboardData.files).find((f) => f.type.startsWith('image/'));
        if (imageFile) {
          insertUploadedImage(uploadImageFile(imageFile));
          return true;
        }

        // Copy ảnh từ website khác thường không đưa ra file nhị phân, chỉ có HTML dạng
        // <img src="https://nguồn-gốc/...">. Chỉ can thiệp khi nội dung dán vào CHỈ có đúng 1
        // ảnh (không có chữ/bảng khác đi kèm) — tránh chặn nhầm paste nội dung hỗn hợp (đoạn
        // văn, bảng Excel...) đã được ProseMirror tự parse đúng theo luồng mặc định.
        const html = clipboardData.getData('text/html');
        if (html) {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const imgs = doc.body.querySelectorAll('img');
          const textOnly = (doc.body.textContent || '').trim();
          if (imgs.length === 1 && textOnly.length === 0) {
            const src = imgs[0].getAttribute('src');
            if (src && /^https?:\/\//i.test(src)) {
              insertUploadedImage(uploadImageFromUrl(src));
              return true;
            }
          }
        }

        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON() as TiptapDoc);
    },
  });

  // Notify parent khi editor sẵn sàng
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Bật/tắt Chỉnh sửa (View ↔ Edit mode) trên cùng 1 editor instance
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // Đồng bộ content từ ngoài vào (vd khi load dữ liệu hoặc chuyển sang xem Article khác) —
  // chỉ set lại khi thực sự khác, tránh vòng lặp/mất vị trí con trỏ khi tự gõ.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getJSON();
    const next = normalizeForEditor(value);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!editor) return null;

  return (
    <div className={`tiptap-editor-wrap${editable ? '' : ' tiptap-editor-wrap--readonly'}`}>
      {editable && <TiptapToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
