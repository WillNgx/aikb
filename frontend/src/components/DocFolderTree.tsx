import React, { useState, useRef, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import {
  useTreeQuery,
  useMoveNode,
  useReorderNodes,
  useUpdateNode,
  countDescendantsInTree,
  isDescendantOf,
  findNodeInTree,
  getAllFolders,
} from "../hooks/useTree";
import { useAuthUser, type TreeNodeDTO } from "../api";
import { useAlert } from "./ConfirmModal";

interface DocFolderTreeProps {
  onItemSelect?: () => void;
  compact?: boolean;
}

const DRAG_THRESHOLD_PX = 4;

interface PointerDragInfo {
  nodeId: string;
  nodeType: "folder" | "article";
  parentId: string | null;
  startX: number;
  startY: number;
  active: boolean;
}

/** Danh sách các node cùng cấp cha parentId (null = root), đúng thứ tự hiện tại đang hiển thị. */
function getSiblingsList(
  allNodes: TreeNodeDTO[],
  parentId: string | null,
): TreeNodeDTO[] {
  if (parentId === null) return allNodes;
  const parent = findNodeInTree(parentId, allNodes);
  return parent?.children ?? [];
}

export default function DocFolderTree({
  onItemSelect,
  compact = false,
}: DocFolderTreeProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Search filter term for tree
  const [searchTerm, setSearchTerm] = useState("");
  const thongBao = useAlert();
  const { t } = useTranslation();
  const { isAdmin } = useAuthUser();

  // React Query tree data & mutations
  const { data: treeData = [], isLoading } = useTreeQuery();
  const moveNodeMutation = useMoveNode();
  const reorderNodesMutation = useReorderNodes();
  const updateNodeMutation = useUpdateNode();
  const treeDataRef = useRef(treeData);
  treeDataRef.current = treeData;

  // Đổi tên inline (folder lẫn article) — trước đây chưa có ở bất kỳ đâu trong app.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startRename = (node: TreeNodeDTO, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(node.id);
    setRenameValue(node.name);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    const id = renamingId;
    setRenamingId(null);
    if (!trimmed) return; // để trống rồi Enter/blur — không đổi gì, khớp hành vi tạo folder
    updateNodeMutation.mutate({ id, data: { name: trimmed } });
  };

  // ─── Kéo/thả bằng Pointer Events (KHÔNG dùng native HTML5 draggable) ────────
  // Native HTML5 drag-and-drop (draggable="true" + dragstart/dragover/drop) phụ thuộc vào
  // trình duyệt tự nhận diện "đây là 1 cử chỉ kéo" — hành vi này không nhất quán giữa các
  // trình duyệt/thiết bị (đặc biệt chuột cảm ứng/trackpad), và trong thực tế đã không hoạt
  // động được cho người dùng. Cách làm dưới đây tự quản lý toàn bộ vòng đời kéo/thả bằng
  // pointerdown/pointermove/pointerup — hoạt động giống nhau trên mọi loại con trỏ (chuột,
  // trackpad, bút cảm ứng, cảm ứng ngón tay), không phụ thuộc engine drag riêng của trình duyệt.
  const dragInfoRef = useRef<PointerDragInfo | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTargetNodeId, setDropTargetNodeId] = useState<string | null>(null);
  // Thả vào nửa trên/dưới của 1 mục CÙNG CẤP CHA với mục đang kéo → chèn vị trí (đổi thứ tự),
  // khác với dropTargetNodeId (thả vào GIỮA 1 folder để đổi cha).
  const [reorderTarget, setReorderTarget] = useState<{
    nodeId: string;
    position: "before" | "after";
  } | null>(null);
  const [isOverRootZone, setIsOverRootZone] = useState<boolean>(false);
  const [ghostLabel, setGhostLabel] = useState<string>("");
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const treeBodyRef = useRef<HTMLDivElement>(null);

  // Expanded nodes map
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({
    "f-the-thao": false,
  });

  // Extract active ID from URL
  const queryParams = new URLSearchParams(location.search);
  const activeFolderId = queryParams.get("folder");
  const activeArticleId = location.pathname.startsWith("/wiki/")
    ? location.pathname.replace("/wiki/", "")
    : null;

  const activeId = activeArticleId || activeFolderId || null;

  const toggleNode = (nodeId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedNodes((prev) => ({
      ...prev,
      [nodeId]: !prev[nodeId],
    }));
  };

  // Nút thu gọn/mở rộng toàn bộ cây — chiều toggle luôn suy trực tiếp từ trạng thái hiện tại:
  // đang có ít nhất 1 folder mở thì thu gọn hết; đang đóng hết thì mở hết.
  const isAnyExpanded = Object.values(expandedNodes).some(Boolean);
  const handleToggleCollapseAll = () => {
    if (isAnyExpanded) {
      setExpandedNodes({});
      return;
    }
    const next: Record<string, boolean> = {};
    getAllFolders(treeData).forEach((f) => {
      next[f.id] = true;
    });
    setExpandedNodes(next);
  };

  const handleSelectNode = (node: TreeNodeDTO) => {
    // Chỉ điều hướng — không tự động thu gọn/mở rộng kèm theo. Thu gọn/mở rộng 1 folder
    // riêng lẻ chỉ xảy ra khi bấm đúng mũi tên (tree-arrow-box), không phải cả hàng.
    if (node.type === "folder") {
      navigate(`/documents?folder=${node.id}`);
    } else {
      navigate(`/wiki/${node.id}`);
    }
    if (onItemSelect) onItemSelect();
  };

  // Helper matching search
  const matchesSearch = (node: TreeNodeDTO, term: string): boolean => {
    if (!term) return true;
    const cleanTerm = term.toLowerCase().trim();
    if (node.name.toLowerCase().includes(cleanTerm)) return true;
    if (node.children && node.children.length > 0) {
      return node.children.some((c) => matchesSearch(c, term));
    }
    return false;
  };

  // Helper highlight search term
  const renderHighlightedText = (text: string, term: string) => {
    if (!term || !term.trim()) return text;
    const cleanTerm = term.trim().toLowerCase();
    const idx = text.toLowerCase().indexOf(cleanTerm);
    if (idx === -1) return text;

    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + cleanTerm.length);
    const after = text.slice(idx + cleanTerm.length);

    return (
      <>
        {before}
        <span className="tree-search-highlight">{match}</span>
        {after}
      </>
    );
  };

  const resetDragState = () => {
    dragInfoRef.current = null;
    setDraggingNodeId(null);
    setDropTargetNodeId(null);
    setReorderTarget(null);
    setIsOverRootZone(false);
    setGhostPos(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  // Tìm row `.tree-item-canva` đang nằm dưới con trỏ (qua data-node-id) và xác định
  // có phải đang hover vùng Root (bên trong doc-tree-body nhưng không nằm trên row nào).
  // Row luôn được ưu tiên trước — vì cả banner Root lẫn body scroll container đều mang
  // data-root-drop-zone, mà mọi row lại nằm lồng bên trong body container đó.
  // edgeZone chia row thành 3 vùng dọc (top/middle/bottom): hover top/bottom của 1 mục CÙNG
  // CẤP CHA với mục đang kéo → chèn vị trí trước/sau (đổi thứ tự); vùng middle vẫn coi như thả
  // vào giữa row đó như cũ (vd để đổi cha, nếu đó là 1 Thư mục) — giữ nguyên khả năng thả 1 node
  // vào bên trong 1 Thư mục anh em thay vì chỉ có thể đổi chỗ nó.
  const resolveDropAt = (clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY);
    const rowEl = el?.closest<HTMLElement>("[data-node-id]");
    if (rowEl) {
      const rect = rowEl.getBoundingClientRect();
      const relativeY = (clientY - rect.top) / rect.height;
      const edgeZone: "top" | "middle" | "bottom" =
        relativeY < 0.3 ? "top" : relativeY > 0.7 ? "bottom" : "middle";
      return {
        nodeId: rowEl.dataset.nodeId ?? null,
        nodeType: rowEl.dataset.nodeType ?? null,
        parentId: rowEl.dataset.nodeParentId
          ? rowEl.dataset.nodeParentId
          : null,
        edgeZone,
        overRootZone: false,
      };
    }
    const rootZoneEl = el?.closest<HTMLElement>("[data-root-drop-zone]");
    return {
      nodeId: null,
      nodeType: null,
      parentId: null,
      edgeZone: "middle" as const,
      overRootZone: Boolean(rootZoneEl),
    };
  };

  const handleGripPointerDown = (e: React.PointerEvent, node: TreeNodeDTO) => {
    if (e.button !== 0 && e.pointerType === "mouse") return; // chỉ chuột trái
    e.preventDefault();
    e.stopPropagation();

    dragInfoRef.current = {
      nodeId: node.id,
      nodeType: node.type,
      parentId: node.parentId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };

    const handlePointerMove = (ev: PointerEvent) => {
      const info = dragInfoRef.current;
      if (!info) return;

      if (!info.active) {
        const dx = Math.abs(ev.clientX - info.startX);
        const dy = Math.abs(ev.clientY - info.startY);
        if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
        info.active = true;
        setDraggingNodeId(info.nodeId);
        setGhostLabel(node.name);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }

      setGhostPos({ x: ev.clientX, y: ev.clientY });

      const {
        nodeId: overNodeId,
        nodeType: overNodeType,
        parentId: overParentId,
        edgeZone,
        overRootZone,
      } = resolveDropAt(ev.clientX, ev.clientY);

      if (overRootZone) {
        setIsOverRootZone(true);
        setDropTargetNodeId(null);
        setReorderTarget(null);
        return;
      }
      setIsOverRootZone(false);

      // Hover vùng top/bottom của 1 "anh em" (cùng parentId với node đang kéo, khác chính nó)
      // → chèn vị trí trước/sau (đổi thứ tự). Vùng middle rơi xuống logic thả-vào-folder bên
      // dưới như cũ (vẫn thả được vào bên trong 1 Thư mục anh em, không chỉ đổi chỗ nó).
      const isSibling =
        Boolean(overNodeId) &&
        overNodeId !== info.nodeId &&
        overParentId === info.parentId &&
        edgeZone !== "middle";
      if (isSibling) {
        setReorderTarget({
          nodeId: overNodeId as string,
          position: edgeZone === "top" ? "before" : "after",
        });
        setDropTargetNodeId(null);
        return;
      }
      setReorderTarget(null);

      const isValidTarget =
        overNodeId &&
        overNodeId !== info.nodeId &&
        overNodeType === "folder" &&
        !isDescendantOf(info.nodeId, overNodeId, treeDataRef.current);

      setDropTargetNodeId(isValidTarget ? overNodeId : null);
    };

    const handlePointerUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      const info = dragInfoRef.current;
      if (info?.active) {
        const {
          nodeId: overNodeId,
          nodeType: overNodeType,
          parentId: overParentId,
          edgeZone,
          overRootZone,
        } = resolveDropAt(ev.clientX, ev.clientY);

        const isSibling =
          Boolean(overNodeId) &&
          overNodeId !== info.nodeId &&
          overParentId === info.parentId &&
          edgeZone !== "middle";

        if (isSibling) {
          const siblings = getSiblingsList(
            treeDataRef.current,
            info.parentId,
          ).filter((n) => n.id !== info.nodeId);
          const targetIndex = siblings.findIndex((n) => n.id === overNodeId);
          const insertIndex =
            targetIndex === -1
              ? siblings.length
              : edgeZone === "top"
                ? targetIndex
                : targetIndex + 1;
          const orderedIds = [
            ...siblings.slice(0, insertIndex).map((n) => n.id),
            info.nodeId,
            ...siblings.slice(insertIndex).map((n) => n.id),
          ];
          reorderNodesMutation.mutate(
            { parentId: info.parentId, orderedIds },
            {
              onError: (err: any) =>
                thongBao(
                  err?.response?.data?.error || t("tree.reorderFailed"),
                ),
            },
          );
        } else if (overRootZone) {
          moveNodeMutation.mutate(
            { id: info.nodeId, parentId: null },
            {
              onError: (err: any) =>
                thongBao(
                  err?.response?.data?.error || t("tree.moveToRootFailed"),
                ),
            },
          );
        } else if (
          overNodeId &&
          overNodeId !== info.nodeId &&
          overNodeType === "folder" &&
          !isDescendantOf(info.nodeId, overNodeId, treeDataRef.current)
        ) {
          const targetId = overNodeId;
          moveNodeMutation.mutate(
            { id: info.nodeId, parentId: targetId },
            {
              onSuccess: () =>
                setExpandedNodes((prev) => ({ ...prev, [targetId]: true })),
              onError: (err: any) =>
                thongBao(err?.response?.data?.error || t("tree.moveFailed")),
            },
          );
        }
      }

      resetDragState();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  // Dọn dẹp phòng trường hợp component unmount giữa lúc đang kéo (VD điều hướng trang)
  useEffect(() => {
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, []);

  // Check if searching to auto-expand matching parents
  const isSearching = searchTerm.trim().length > 0;

  // Render recursive tree node
  const renderNode = (node: TreeNodeDTO, depth: number = 0) => {
    if (isSearching && !matchesSearch(node, searchTerm)) {
      return null;
    }

    const hasChildren = Boolean(node.children && node.children.length > 0);
    const isExpanded = isSearching ? true : Boolean(expandedNodes[node.id]);
    const isActive = activeId === node.id;
    const descendantCount = hasChildren ? countDescendantsInTree(node) : 0;
    const isDropTarget = dropTargetNodeId === node.id;
    const isDragging = draggingNodeId === node.id;
    const isReorderBefore =
      reorderTarget?.nodeId === node.id && reorderTarget.position === "before";
    const isReorderAfter =
      reorderTarget?.nodeId === node.id && reorderTarget.position === "after";

    return (
      <div
        key={node.id}
        className="tree-node-wrapper"
        style={{ paddingLeft: depth > 0 ? 10 : 0 }}
      >
        <div
          className={`tree-item-canva ${isActive ? "active" : ""} ${node.type} ${isDropTarget ? "drag-over-target" : ""} ${isDragging ? "is-dragging-node" : ""} ${isReorderBefore ? "drop-indicator-before" : ""} ${isReorderAfter ? "drop-indicator-after" : ""}`}
          data-node-id={node.id}
          data-node-type={node.type}
          data-node-parent-id={node.parentId ?? ""}
          onClick={() => handleSelectNode(node)}
        >
          {/* Drag Handle Gripper — điểm kéo duy nhất của cả row, dùng Pointer Events
              (không phải native HTML5 draggable) để hoạt động nhất quán trên mọi thiết bị. */}
          <span
            className="tree-drag-grip"
            title={t("tree.dragHandle")}
            onPointerDown={(e) => handleGripPointerDown(e, node)}
            onClick={(e) => e.stopPropagation()}
          >
            ⠿
          </span>

          {/* Arrow */}
          <span
            className="tree-arrow-box"
            onClick={(e) => {
              if (hasChildren) toggleNode(node.id, e);
            }}
          >
            {hasChildren ? (
              <span className="tree-arrow-symbol">
                {isExpanded ? "▾" : "▸"}
              </span>
            ) : (
              <span className="tree-arrow-spacer" />
            )}
          </span>

          {/* Icon */}
          <span className="tree-node-icon">
            {node.type === "folder" ? (
              <span style={{ color: "#f59e0b", fontSize: "1rem" }}>
                {isExpanded ? "📂" : "📁"}
              </span>
            ) : (
              <span style={{ color: "#38bdf8", fontSize: "0.95rem" }}>📄</span>
            )}
          </span>

          {/* Label — hoặc ô input đổi tên inline nếu đang renaming */}
          {renamingId === node.id ? (
            <input
              type="text"
              className="tree-rename-input"
              value={renameValue}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenamingId(null);
              }}
            />
          ) : (
            <span className="tree-node-label" title={node.name}>
              {renderHighlightedText(node.name || t("tree.untitled"), searchTerm)}
            </span>
          )}

          {/* Draft/Published — chỉ Article mới có vòng đời thật, Folder không hiển thị badge */}
          {node.type === "article" && renamingId !== node.id && (
            <span
              className={`tree-status-dot ${node.status === "published" ? "published" : "draft"}`}
              title={node.status === "published" ? t("docs.statusPublished") : t("docs.statusDraft")}
            />
          )}

          {/* Đổi tên — hiện khi hover row */}
          {renamingId !== node.id && (
            <button
              type="button"
              className="tree-rename-trigger"
              title={t("tree.rename")}
              onClick={(e) => startRename(node, e)}
            >
              ✏️
            </button>
          )}

          {/* Children count */}
          {hasChildren && (
            <span
              className="tree-descendant-count"
              title={t("tree.descendantCount", { n: descendantCount })}
            >
              {descendantCount}
            </span>
          )}
        </div>

        {/* Children render */}
        {hasChildren && isExpanded && (
          <div className="tree-children-canva">
            {node.children!.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`doc-tree-container-canva ${compact ? "compact" : ""}`}>
      {/* Header & Quick stats */}
      <div className="doc-tree-header-canva">
        <div className="tree-search-row">
          {/* Thu gọn/Mở rộng toàn bộ cây thư mục */}
          <button
            type="button"
            className="tree-collapse-all-btn"
            onClick={handleToggleCollapseAll}
            title={isAnyExpanded ? t("tree.collapseAll") : t("tree.expandAll")}
            aria-label={isAnyExpanded ? t("tree.collapseAll") : t("tree.expandAll")}
          >
            {isAnyExpanded ? "⊟" : "⊞"}
          </button>

          {/* Tree Search Input (Kỹ thuật lọc cây theo Canva.md) */}
          <div className="tree-search-bar">
            <span className="tree-search-icon">🔍</span>
            <input
              type="text"
              className="tree-search-input"
              placeholder={t("tree.filterPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                className="tree-search-clear"
                onClick={() => setSearchTerm("")}
                title={t("tree.clearSearch")}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Vùng Thả Ra Thư Mục Gốc (Root Drop Zone) — Luôn hiển thị khi đang kéo.
          Cố ý nằm NGOÀI vùng cuộn body (không phải overlay đè lên hàng nào) để không bao giờ
          che khuất 1 folder đang hiển thị — chấp nhận việc các hàng dịch xuống 1 chút khi banner
          này xuất hiện, vì đây là hành vi user nhìn thấy và tự điều chỉnh theo, không phải bug. */}
      {draggingNodeId && (
        <div
          className={`tree-root-drop-zone ${isOverRootZone ? "active" : ""}`}
          data-root-drop-zone="true"
        >
          <span className="root-zone-icon">🏠</span>
          <span className="root-zone-text">
            {t("tree.rootDropZone")}
          </span>
        </div>
      )}

      {/* Tree scrollable body — Cuộn mượt mà nhưng ẩn hoàn toàn thanh cuộn UI */}
      <div
        ref={treeBodyRef}
        className={`doc-tree-body-canva scroll-hidden ${isOverRootZone ? "body-root-hover" : ""}`}
        data-root-drop-zone={draggingNodeId ? "true" : undefined}
      >
        {isLoading ? (
          <div
            style={{
              padding: "1rem",
              color: "var(--color-text-muted)",
              fontSize: "0.825rem",
              textAlign: "center",
            }}
          >
            ⏳ {t("tree.loading")}
          </div>
        ) : treeData.length === 0 ? (
          <div
            style={{
              padding: "1.5rem 1rem",
              color: "var(--color-text-muted)",
              fontSize: "0.825rem",
              textAlign: "center",
            }}
          >
            📁 {t("tree.empty")}
            {/* Chỉ quản trị mới có nút tạo thư mục. Tên nút lấy thẳng từ từ điển để đổi tên nút
                thì câu gợi ý tự khớp theo — câu cũ từng nhắc nút "+ Thêm mới" đã không còn. */}
            {isAdmin && (
              <>
                <br />
                <Trans
                  i18nKey="tree.emptyHint"
                  values={{ button: `+ ${t("docs.folder")}` }}
                  components={{ b: <strong /> }}
                />
              </>
            )}
          </div>
        ) : (
          treeData.map((rootNode) => renderNode(rootNode, 0))
        )}
      </div>

      {/* Ghost preview theo con trỏ khi đang kéo */}
      {draggingNodeId && ghostPos && (
        <div
          className="tree-drag-ghost"
          style={{ left: ghostPos.x + 14, top: ghostPos.y + 10 }}
        >
          ⠿ {ghostLabel}
        </div>
      )}
    </div>
  );
}
