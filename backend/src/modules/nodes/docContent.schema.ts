import { z } from 'zod';

/**
 * Validate hình dạng 1 tài liệu TipTap (ProseMirror JSON doc — frontend/src/data/docModel.ts,
 * kết quả editor.getJSON()) khi Admin PATCH body của 1 Article. Cố ý permissive về nội dung
 * node (endpoint chỉ Admin gọi, không phải input công khai) — mục tiêu là chặn JSON hỏng cấu
 * trúc, không phải mô hình hoá chính xác từng loại node/mark của TipTap.
 */
const tiptapMarkSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const tiptapNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(tiptapNodeSchema).optional(),
    marks: z.array(tiptapMarkSchema).optional(),
    text: z.string().optional(),
  })
);

export const tiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(tiptapNodeSchema),
});
