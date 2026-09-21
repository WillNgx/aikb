/**
 * Document Content Model — 1 tài liệu TipTap liên tục (Word-style), thay thế mô hình
 * cây BlockNode (Notion-style) cũ. `body` của Article giờ lưu trực tiếp JSON doc chuẩn
 * ProseMirror/TipTap (editor.getJSON()) thay vì BlockNode[].
 */
import i18n from '../lib/i18n';


export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

export interface TiptapDoc {
  type: 'doc';
  content: TiptapNode[];
}

/** Tài liệu rỗng ban đầu — dùng khi Article mới chưa có body, hoặc body cũ không đọc được. */
export function createEmptyDoc(): TiptapDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** Nhận diện body có đúng hình dạng TipTap doc hay không (vd body cũ theo BlockNode[] rơi vào đây). */
export function isTiptapDoc(value: unknown): value is TiptapDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** Chuẩn hoá body đọc từ API: doc hợp lệ giữ nguyên, ngược lại (rỗng/không đọc được) trả về doc rỗng. */
export function normalizeDoc(body: unknown): TiptapDoc {
  return isTiptapDoc(body) ? body : createEmptyDoc();
}

/** true nếu doc coi như "chưa gõ gì" (rỗng hoàn toàn, hoặc chỉ 1 đoạn văn trống mặc định). */
export function isEmptyDoc(doc: TiptapDoc | null | undefined): boolean {
  if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return true;
  if (doc.content.length === 1) {
    const only = doc.content[0];
    if (only.type === 'paragraph' && !only.content?.length) return true;
  }
  return false;
}

export interface TocItem {
  id: string;
  title: string;
  level: number;
  subItems?: TocItem[];
}

/**
 * Duyệt cây doc theo đúng thứ tự depth-first mà ProseMirror dùng nội bộ (node cha trước, rồi
 * tới children, theo thứ tự content) — PHẢI khớp chính xác với plugin gắn id neo heading
 * (frontend/src/extensions/HeadingAnchor.ts, dùng state.doc.descendants), vì id neo được tính
 * lại mỗi lần render theo thứ tự xuất hiện thay vì lưu cố định trong dữ liệu.
 */
function walkNodes(nodes: TiptapNode[] | undefined, visit: (node: TiptapNode) => void) {
  if (!nodes) return;
  for (const node of nodes) {
    visit(node);
    walkNodes(node.content, visit);
  }
}

function headingText(node: TiptapNode): string {
  return (node.content || [])
    .map((child) => (child.type === 'text' ? child.text || '' : headingText(child)))
    .join('')
    .trim();
}

/** Trích mục lục (TOC) phân cấp H1 → H2 → H3 từ doc, id khớp với HeadingAnchor extension. */
export function extractTocFromDoc(doc: TiptapDoc | null | undefined): TocItem[] {
  const toc: TocItem[] = [];
  let headingIndex = 0;
  let lastH1: TocItem | null = null;
  let lastH2: TocItem | null = null;

  walkNodes(doc?.content, (node) => {
    if (node.type !== 'heading') return;
    const id = `heading-${headingIndex}`;
    const level = Number(node.attrs?.level) || 1;
    headingIndex += 1;
    const title = headingText(node) || i18n.t('wiki.sectionFallback', { n: headingIndex });
    const item: TocItem = { id, title, level };

    if (level === 1) {
      toc.push(item);
      lastH1 = item;
      lastH2 = null;
      return;
    }
    if (level === 2) {
      const parent = lastH1;
      if (parent) {
        parent.subItems = parent.subItems || [];
        parent.subItems.push(item);
      } else {
        toc.push(item);
      }
      lastH2 = item;
      return;
    }
    // level >= 3
    const parent = lastH2 || lastH1;
    if (parent) {
      parent.subItems = parent.subItems || [];
      parent.subItems.push(item);
    } else {
      toc.push(item);
    }
  });

  return toc;
}
