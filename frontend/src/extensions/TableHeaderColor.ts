import TableHeader from '@tiptap/extension-table-header';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableHeaderColor: {
      /** Đổi màu nền của CẢ hàng tiêu đề (mọi ô tableHeader) trong bảng đang chứa con trỏ. */
      setTableHeaderColor: (color: string | null) => ReturnType;
    };
  }
}

/**
 * Mở rộng TableHeader (giữ nguyên hành vi mặc định) để có thêm thuộc tính màu nền + command
 * áp màu cho cả hàng tiêu đề cùng lúc — khớp hành vi "màu tiêu đề bảng" của hệ thống cũ
 * (BlockNode.tableData.headerColor áp cho cả thead, không phải từng ô riêng lẻ).
 */
export const TableHeaderColor = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) => element.style.backgroundColor || null,
        renderHTML: (attributes) => {
          if (!attributes.backgroundColor) return {};
          // Bảng màu tiêu đề (TABLE_HEADER_COLORS) chỉ gồm màu pastel nhạt, cố định — không đổi
          // theo theme sáng/tối. Phải ép chữ màu tối cố định đi kèm, nếu không chữ sẽ kế thừa
          // --color-text (tự đổi trắng ở dark mode) và gần như không đọc được trên nền nhạt đó.
          return { style: `background-color: ${attributes.backgroundColor}; color: #1f2933;` };
        },
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setTableHeaderColor:
        (color: string | null) =>
        ({ state, tr, dispatch }) => {
          const { $from } = state.selection;
          let tablePos = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'table') {
              tablePos = $from.before(d);
              break;
            }
          }
          if (tablePos === -1) return false;

          const tableNode = tr.doc.nodeAt(tablePos);
          if (!tableNode) return false;

          if (dispatch) {
            tableNode.descendants((node, relativePos) => {
              if (node.type.name === 'tableHeader') {
                tr.setNodeMarkup(tablePos + 1 + relativePos, undefined, {
                  ...node.attrs,
                  backgroundColor: color,
                });
              }
            });
          }
          return true;
        },
    };
  },
});

export default TableHeaderColor;
