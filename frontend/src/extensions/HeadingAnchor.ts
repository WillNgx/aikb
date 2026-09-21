import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import i18n from '../lib/i18n';

const COPY_ICON = '🔗';
const COPIED_ICON = '✅';

// Nút "copy link" chèn ngay sau chữ cuối của heading H1/H2 (widget decoration — không phải
// document node nên không lọt vào body lưu xuống DB). Ẩn/hiện bằng CSS theo chế độ Xem/Chỉnh
// sửa (xem wikiArticle.css), ở đây chỉ lo hành vi copy + phản hồi đã copy.
function createCopyLinkButton(anchorId: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'heading-copy-link-btn';
  btn.contentEditable = 'false';
  btn.setAttribute('aria-label', i18n.t('editor.copyHeadingLink'));
  btn.title = i18n.t('editor.copyHeadingLink');
  btn.textContent = COPY_ICON;

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const url = `${window.location.origin}${window.location.pathname}#${anchorId}`;
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = COPIED_ICON;
      setTimeout(() => {
        btn.textContent = COPY_ICON;
      }, 1500);
    });
  });

  return btn;
}

/**
 * Gắn id neo (vd "heading-0", "heading-1"...) cho mọi heading trong doc, theo đúng thứ tự
 * xuất hiện (state.doc.descendants — duyệt cha trước, rồi tới children, theo thứ tự content).
 * Dùng để Mục lục (TOC) và link "#heading-N" cuộn tới đúng vị trí, kể cả khi đang ở chế độ
 * Chỉnh sửa. Chỉ là decoration (không sửa document) — PHẢI khớp đúng thứ tự đếm với
 * extractTocFromDoc (frontend/src/data/docModel.ts) vì id được tính lại mỗi lần render thay
 * vì lưu cố định trong dữ liệu.
 *
 * Heading H1/H2 (không áp dụng H3) còn được chèn thêm nút "copy link" — cũng là widget
 * decoration, đặt ngay trước tag đóng của heading để nằm inline sau chữ cuối cùng.
 */
export const HeadingAnchor = Extension.create({
  name: 'headingAnchor',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('headingAnchor'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            let index = 0;
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'heading') {
                const anchorId = `heading-${index}`;
                decorations.push(Decoration.node(pos, pos + node.nodeSize, { id: anchorId }));
                if (node.attrs.level === 1 || node.attrs.level === 2) {
                  decorations.push(
                    Decoration.widget(pos + node.nodeSize - 1, () => createCopyLinkButton(anchorId), {
                      stopEvent: () => true,
                    })
                  );
                }
                index += 1;
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export default HeadingAnchor;
