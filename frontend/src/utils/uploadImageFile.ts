import { uploadsApi } from '../api';
import i18n from '../lib/i18n';

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Upload 1 file ảnh qua Supabase Storage (dùng chung cho nút "Chèn ảnh" trên toolbar và
 * paste ảnh trực tiếp từ clipboard trong editor). Trả về URL ảnh, hoặc throw Error với message
 * tiếng Việt để chỗ gọi hiển thị trực tiếp cho người dùng.
 */
export async function uploadImageFile(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error(i18n.t('editor.imageTooLarge'));
  }
  try {
    const dataUri = await fileToDataUri(file);
    const { url } = await uploadsApi.uploadImage(dataUri);
    return url;
  } catch (err: any) {
    throw new Error(err?.response?.data?.error || i18n.t('editor.imageUploadFailed'));
  }
}

/**
 * Dán ảnh copy từ website khác (clipboard chỉ có URL ảnh gốc, không có file nhị phân) — nhờ
 * backend tải ảnh về rồi lưu vào Storage của app, tránh CORS khi fetch thẳng từ trình duyệt.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  try {
    const { url } = await uploadsApi.uploadImageFromUrl(imageUrl);
    return url;
  } catch (err: any) {
    throw new Error(err?.response?.data?.error || i18n.t('editor.imageFromUrlFailed'));
  }
}
