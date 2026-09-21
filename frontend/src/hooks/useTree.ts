import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { nodesApi } from '../api';
import type { TreeNodeDTO } from '../api';

// ─── Query Keys ───────────────────────────────────────────────────────────────
export const TREE_KEY = ['nodes', 'tree'] as const;
export const nodeKey = (id: string) => ['nodes', id] as const;

// ─── Helper: tìm node theo ID trong cây đệ quy ────────────────────────────────
export function findNodeInTree(id: string, nodes: TreeNodeDTO[]): TreeNodeDTO | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children && node.children.length > 0) {
      const found = findNodeInTree(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

// ─── Helper: lấy đường dẫn từ root đến node ─────────────────────────────────
export function getPathToNode(id: string, nodes: TreeNodeDTO[], path: TreeNodeDTO[] = []): TreeNodeDTO[] | null {
  for (const node of nodes) {
    const currentPath = [...path, node];
    if (node.id === id) return currentPath;
    if (node.children && node.children.length > 0) {
      const found = getPathToNode(id, node.children, currentPath);
      if (found) return found;
    }
  }
  return null;
}

// ─── Helper: đếm tổng số descendants ─────────────────────────────────────────
export function countDescendantsInTree(node: TreeNodeDTO): number {
  if (!node.children || node.children.length === 0) return 0;
  return node.children.reduce((sum, child) => sum + 1 + countDescendantsInTree(child), 0);
}

// ─── Helper: tìm tất cả folders để hiển thị trong Quick Move Modal ────────────
export function getAllFolders(nodes: TreeNodeDTO[]): TreeNodeDTO[] {
  const folders: TreeNodeDTO[] = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      folders.push(node);
      if (node.children && node.children.length > 0) {
        folders.push(...getAllFolders(node.children));
      }
    }
  }
  return folders;
}

// ─── Helper: BR-012 — Folder có chứa Article nào trong cây con không (đệ quy, kể cả Article
// nằm trong thư mục con) ─────────────────────────────────────────────────────
export function hasArticleDescendant(node: TreeNodeDTO): boolean {
  if (!node.children) return false;
  for (const child of node.children) {
    if (child.type === 'article') return true;
    if (hasArticleDescendant(child)) return true;
  }
  return false;
}

// ─── Helper: kiểm tra circular reference ─────────────────────────────────────
export function isDescendantOf(sourceId: string, targetId: string, nodes: TreeNodeDTO[]): boolean {
  const source = findNodeInTree(sourceId, nodes);
  if (!source || !source.children) return false;
  for (const child of source.children) {
    if (child.id === targetId) return true;
    if (isDescendantOf(child.id, targetId, source.children)) return true;
  }
  return false;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Hook lấy toàn bộ cây thư mục */
export function useTreeQuery() {
  return useQuery<TreeNodeDTO[]>({
    queryKey: TREE_KEY,
    queryFn: nodesApi.getTree,
    staleTime: 30 * 1000, // 30 giây
  });
}

/** Hook lấy chi tiết 1 node */
export function useNodeQuery(id: string | undefined) {
  return useQuery<TreeNodeDTO>({
    queryKey: nodeKey(id!),
    queryFn: () => nodesApi.getById(id!),
    enabled: !!id,
    staleTime: 30 * 1000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Tạo node mới (folder hoặc article) */
export function useCreateNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name?: string; type: 'folder' | 'article'; parentId?: string | null }) =>
      nodesApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
    },
  });
}

/** Cập nhật tên hoặc body (Save Draft) */
export function useUpdateNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; body?: unknown } }) =>
      nodesApi.update(id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
      queryClient.invalidateQueries({ queryKey: nodeKey(updated.id) });
    },
  });
}

/** Di chuyển node sang parentId mới */
export function useMoveNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      nodesApi.move(id, parentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
    },
  });
}

/** Đánh dấu/bỏ đánh dấu 1 Folder là Provider (sảnh cược) — chỉ Admin */
export function useSetProviderFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isProvider }: { id: string; isProvider: boolean }) =>
      nodesApi.setProvider(id, isProvider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
    },
  });
}

/** Sắp xếp lại vị trí các node cùng cấp cha (kéo/thả đổi thứ tự trong cây) */
export function useReorderNodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, orderedIds }: { parentId: string | null; orderedIds: string[] }) =>
      nodesApi.reorder(parentId, orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
    },
  });
}

/** Publish article */
export function usePublishNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => nodesApi.publish(id),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
      queryClient.invalidateQueries({ queryKey: nodeKey(updated.id) });
    },
  });
}

/** Xóa node */
export function useDeleteNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => nodesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
    },
  });
}
