import { db } from './index';
import { nodes, users } from './schema';

async function seedInitialTree() {
  console.log('🌱 Đang kiểm tra và khởi tạo dữ liệu mẫu cây thư mục vào Database...');

  // Lấy 1 user admin làm tác giả mặc định nếu có
  const [adminUser] = await db.select().from(users).limit(1);
  const authorId = adminUser ? adminUser.id : null;

  // 1. Thư mục gốc: Thể thao
  const [theThao] = await db
    .insert(nodes)
    .values({
      name: 'Thể thao',
      type: 'folder',
      parentId: null,
      status: 'published',
      sortOrder: 1,
      createdBy: authorId,
    })
    .returning();

  // 2. Thư mục con: Thông tin chung
  const [ttChung] = await db
    .insert(nodes)
    .values({
      name: 'Thông tin chung',
      type: 'folder',
      parentId: theThao.id,
      status: 'published',
      sortOrder: 1,
      createdBy: authorId,
    })
    .returning();

  // 3. Thư mục con: Bet Types
  const [betTypes] = await db
    .insert(nodes)
    .values({
      name: 'Bet Types',
      type: 'folder',
      parentId: ttChung.id,
      status: 'published',
      sortOrder: 1,
      createdBy: authorId,
    })
    .returning();

  // 4. Thư mục con: Cược chính
  const [cuocChinh] = await db
    .insert(nodes)
    .values({
      name: 'Cược chính',
      type: 'folder',
      parentId: betTypes.id,
      status: 'published',
      sortOrder: 1,
      createdBy: authorId,
    })
    .returning();

  // 5. Bài viết: Cược xiên tổng hợp
  await db.insert(nodes).values({
    name: 'Cược xiên tổng hợp',
    type: 'article',
    parentId: cuocChinh.id,
    status: 'published',
    sortOrder: 1,
    createdBy: authorId,
    body: [
      {
        id: 'blk-cx-h1-1',
        type: 'h1',
        text: '2.1.7.12.1 GIỚI THIỆU CHUNG',
        children: [
          {
            id: 'blk-cx-p-1',
            type: 'content',
            text: 'Một xiên tổng hợp là sự kết hợp hai hay nhiều lựa chọn trong một lần đặt cược. Mỗi lựa chọn được chọn trong xiên phải thắng thì vé cược xiên sẽ thắng. Nếu lựa chọn đầu tiên là cược thắng, tiền thắng và tiền cược được chuyển qua lựa chọn thứ hai.',
          },
          {
            id: 'blk-cx-callout-1',
            type: 'callout',
            calloutVariant: 'warning',
            text: 'Lưu ý: Nếu có bất kỳ một lựa chọn nào thua toàn phần, toàn bộ vé cược xiên sẽ thua và không được hoàn tiền.',
          },
          {
            id: 'blk-cx-h2-1',
            type: 'h2',
            text: 'Chi tiết tính tiền cược xiên',
            children: [
              {
                id: 'blk-cx-p-2',
                type: 'content',
                text: 'Công thức tính tiền cược xiên cơ bản: Tiền thắng = Tiền cược * (Tỷ lệ 1 * Tỷ lệ 2 * ... * Tỷ lệ N) - Tiền cược.',
              },
            ],
          },
        ],
      },
    ],
  });

  console.log('✅ Đã seed dữ liệu mẫu cây thư mục thành công vào DB!');
  process.exit(0);
}

seedInitialTree().catch((err) => {
  console.error('❌ Lỗi khi seed dữ liệu:', err);
  process.exit(1);
});
