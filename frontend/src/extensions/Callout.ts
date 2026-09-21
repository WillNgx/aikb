import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

export type CalloutVariant = 'warning' | 'danger' | 'success' | 'info';

export const CALLOUT_VARIANT_ICON: Record<CalloutVariant, string> = {
  warning: '⚠️',
  danger: '🚨',
  success: '✅',
  info: 'ℹ️',
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Bọc block hiện tại (hoặc selection) thành 1 khối Callout với màu variant chỉ định. */
      setCallout: (variant?: CalloutVariant) => ReturnType;
      /** Đổi màu variant của Callout đang chứa con trỏ. */
      updateCalloutVariant: (variant: CalloutVariant) => ReturnType;
      /** Gỡ khối Callout đang chứa con trỏ, giữ lại nội dung bên trong. */
      unsetCallout: () => ReturnType;
    };
  }
}

/**
 * Khối Callout (Cảnh báo / Đặc biệt) — tính năng đặc thù duy nhất được giữ lại từ mô hình
 * block cũ (Notion-style) khi chuyển sang 1 tài liệu TipTap liên tục. Tái dùng đúng class CSS
 * đã có sẵn (.callout-block-box.variant-*) từ hệ thống cũ.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'warning',
        parseHTML: (element) => element.getAttribute('data-variant') || 'warning',
        renderHTML: (attributes) => ({ 'data-variant': attributes.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const variant = (node.attrs.variant as CalloutVariant) || 'warning';
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'callout',
        class: `callout-block-box variant-${variant}`,
      }),
      ['span', { class: 'callout-icon', contenteditable: 'false' }, CALLOUT_VARIANT_ICON[variant]],
      ['div', { class: 'callout-main' }, ['div', { class: 'callout-body' }, 0]],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (variant: CalloutVariant = 'warning') =>
        ({ state, tr, dispatch, commands }) => {
          // Vị trí đầu block hiện tại TRƯỚC khi wrap — sau khi wrapIn, cùng vị trí này (trong
          // tr.doc đã cập nhật) trỏ ngay trước block con vừa lồng vào callout. wrapIn tự nó
          // không di chuyển con trỏ vào bên trong nội dung mới bọc (con trỏ dễ "rơi" ra ngoài,
          // ra 1 đoạn văn mới ProseMirror tự thêm sau callout) — nên đặt lại selection thủ công.
          const blockStart = state.selection.$from.before(state.selection.$from.depth);
          const wrapped = commands.wrapIn(this.name, { variant });
          if (wrapped && dispatch) {
            const $pos = tr.doc.resolve(Math.min(blockStart + 1, tr.doc.content.size));
            tr.setSelection(TextSelection.near($pos, 1));
          }
          return wrapped;
        },
      updateCalloutVariant:
        (variant: CalloutVariant) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { variant }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

export default Callout;
