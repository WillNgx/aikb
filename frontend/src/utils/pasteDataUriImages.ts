/**
 * Dán từ Microsoft Word (bản mới): ảnh nằm thẳng trong HTML clipboard dạng
 * `<img src="data:image/png;base64,...">`. Extension Image của Tiptap mặc định bỏ qua ảnh
 * `data:` (allowBase64 = false) nên khi dán ảnh biến mất. Không bật allowBase64 vì sẽ nhét
 * base64 vào `nodes.body` (phình DB, nặng khi index) → upload từng ảnh lên Storage rồi thay
 * `src` bằng URL, giống nút "Chèn ảnh".
 */

const DATA_IMG_RE = /<img\b[^>]*\ssrc\s*=\s*["']?data:image\//i;

export function hasDataUriImages(html: string): boolean {
  return DATA_IMG_RE.test(html);
}

function dataUriToFile(dataUri: string, index: number): File {
  const match = dataUri.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  if (!match) throw new Error('invalid data uri');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Đuôi file chỉ để dễ nhìn: backend nhận diện định dạng thật theo magic bytes, không tin
  // mime (Word từng gắn nhãn image/png cho dữ liệu JPEG).
  return new File([bytes], `pasted-image-${index + 1}`, { type: match[1] });
}

/**
 * Upload mọi `<img src="data:image/...">` trong HTML, trả HTML đã thay src. Ảnh nào lỗi
 * (quá 5MB, sai định dạng, mạng...) bị gỡ khỏi HTML và tính vào `failed`. Ảnh trùng nhau
 * (Word lặp icon nhỏ nhiều lần) chỉ upload một lần.
 */
export async function replaceDataUriImages(
  html: string,
  upload: (file: File) => Promise<string>
): Promise<{ html: string; failed: number }> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = Array.from(doc.body.querySelectorAll('img')).filter((img) =>
    /^data:image\//i.test(img.getAttribute('src') || '')
  );

  const uploads = new Map<string, Promise<string>>();
  const results = await Promise.allSettled(
    imgs.map(async (img, i) => {
      const src = img.getAttribute('src')!;
      if (!uploads.has(src)) uploads.set(src, upload(dataUriToFile(src, i)));
      img.setAttribute('src', await uploads.get(src)!);
    })
  );

  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed++;
      imgs[i].remove();
    }
  });
  return { html: doc.body.innerHTML, failed };
}
