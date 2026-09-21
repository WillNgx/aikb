import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  useTreeQuery,
  useCreateNode,
  useDeleteNode,
  useSetProviderFlag,
  findNodeInTree,
  getPathToNode,
  countDescendantsInTree,
  hasArticleDescendant,
} from "../hooks/useTree";
import type { TreeNodeDTO } from "../api";
import { useAuthUser } from "../api";
import { useConfirm, useAlert } from "../components/ConfirmModal";

export default function KnowledgeListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const folderId = searchParams.get("folder");
  const { isAdmin } = useAuthUser();
  const confirm = useConfirm();
  const thongBao = useAlert();
  const { t } = useTranslation();

  // React Query tree data & mutations
  const { data: treeData = [], isLoading } = useTreeQuery();
  const createNodeMutation = useCreateNode();
  const deleteNodeMutation = useDeleteNode();
  const setProviderFlagMutation = useSetProviderFlag();

  // Find currently active folder node (or null if browsing all)
  const selectedFolder: TreeNodeDTO | null = folderId
    ? findNodeInTree(folderId, treeData)
    : null;
  const breadcrumbPath: TreeNodeDTO[] = selectedFolder
    ? getPathToNode(selectedFolder.id, treeData) || []
    : [];

  // Modal Add state — CHỈ dùng cho Folder (bắt buộc nhập tên trước khi tạo). Article không có
  // modal/name-prompt — tạo ngay lập tức, xem handleCreateArticleDirect bên dưới (Folio Workflow
  // Spec: "Article không hỏi tên trước — tạo ngay lập tức với tên rỗng, mở thẳng vào soạn thảo").
  const [showAddModal, setShowAddModal] = useState(false);
  const [formName, setFormName] = useState("");
  const [formError, setFormError] = useState("");
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  };

  const handleOpenAdd = () => {
    setFormName("");
    setFormError("");
    setShowAddModal(true);
  };

  const handleCreateFolder = () => {
    if (!formName.trim()) {
      setFormError(t("docs.nameRequired"));
      return;
    }

    const targetParentId = selectedFolder ? selectedFolder.id : null;

    createNodeMutation.mutate(
      { name: formName.trim(), type: "folder", parentId: targetParentId },
      {
        onSuccess: (createdNode) => {
          setShowAddModal(false);
          showToast(t("docs.folderCreated", { name: formName.trim() }));
          if (createdNode?.id) navigate(`/documents?folder=${createdNode.id}`);
        },
        onError: (err: any) => {
          setFormError(err?.response?.data?.error || t("docs.createFolderFailed"));
        },
      }
    );
  };

  // Article: tạo ngay lập tức (tên rỗng), điều hướng thẳng vào /wiki/:id — WikiPage tự động
  // mở Chỉnh sửa vì hasBeenSaved=false, không cần query flag riêng.
  const handleCreateArticleDirect = () => {
    const targetParentId = selectedFolder ? selectedFolder.id : null;
    createNodeMutation.mutate(
      { type: "article", parentId: targetParentId },
      {
        onSuccess: (createdNode) => {
          if (createdNode?.id) navigate(`/wiki/${createdNode.id}`);
        },
        onError: (err: any) => {
          thongBao(err?.response?.data?.error || t("docs.createArticleFailed"));
        },
      }
    );
  };

  // ─── Xóa Node (Folder hoặc Article) — Admin Only ───────────────────────────
  const handleDeleteNode = async (node: TreeNodeDTO, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const isFolder = node.type === "folder";

    // BR-012 Kiểm tra trước: Không thể xóa Folder khi bên trong còn Article (kể cả Article
    // nằm trong thư mục con)
    if (isFolder && hasArticleDescendant(node)) {
      thongBao(t("docs.cannotDeleteFolderWithArticles", { name: node.name }));
      return;
    }

    const confirmMsg = isFolder
      ? t("docs.confirmDeleteFolder", { name: node.name })
      : t("docs.confirmDeleteArticle", { name: node.name });

    if (await confirm(confirmMsg)) {
      deleteNodeMutation.mutate(node.id, {
        onSuccess: (res) => {
          showToast(
            isFolder
              ? t("docs.folderDeleted", { name: node.name })
              : t("docs.articleDeleted", { name: node.name })
          );
          if (selectedFolder && selectedFolder.id === node.id) {
            if (res.parentId) {
              navigate(`/documents?folder=${res.parentId}`);
            } else {
              navigate("/documents");
            }
          }
        },
        onError: (err: any) => {
          thongBao(`⚠️ ${err?.response?.data?.error || t("docs.deleteFailed")}`);
        },
      });
    }
  };

  // ─── Đánh dấu/bỏ đánh dấu 1 Folder là Provider (sảnh cược) — Admin Only ────
  const handleToggleProvider = (node: TreeNodeDTO, e: React.MouseEvent) => {
    e.stopPropagation();
    setProviderFlagMutation.mutate(
      { id: node.id, isProvider: !node.isProvider },
      {
        onSuccess: () =>
          showToast(
            node.isProvider
              ? t("docs.providerUnset", { name: node.name })
              : t("docs.providerSet", { name: node.name })
          ),
        onError: (err: any) =>
          thongBao(err?.response?.data?.error || t("docs.providerUpdateFailed")),
      }
    );
  };

  return (
    <div className="knowledge-hub-page">
      {/* Toast Notification */}
      {toastMsg && (
        <div
          className="alert-box alert-success"
          style={{
            position: "fixed",
            bottom: "1.5rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            boxShadow: "var(--shadow-md)",
          }}
        >
          ✅ {toastMsg}
        </div>
      )}

      {/* Breadcrumb Navigation & Top Action */}
      <div
        className="hub-breadcrumb-bar"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
            flexWrap: "wrap",
          }}
        >
          <button
            className={`crumb-node ${!selectedFolder ? "active" : ""}`}
            onClick={() => navigate("/documents")}
          >
            🏠 {t("docs.home")}
          </button>
          {breadcrumbPath.map((node, idx) => {
            const isLast = idx === breadcrumbPath.length - 1;
            return (
              <span key={node.id} className="crumb-segment">
                <span className="crumb-arrow">/</span>
                <button
                  className={`crumb-node ${isLast ? "active" : ""}`}
                  onClick={() => {
                    if (node.type === "folder") {
                      navigate(`/documents?folder=${node.id}`);
                    } else {
                      navigate(`/wiki/${node.id}`);
                    }
                  }}
                >
                  {node.type === "folder" ? "📁" : "📄"} {node.name}
                </button>
              </span>
            );
          })}
        </div>

        {/* Nút Add — Chỉ hiển thị cho Admin. Folder mở modal hỏi tên; Article tạo ngay lập tức */}
        {isAdmin && (
          <div className="admin-add-actions" style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="btn-secondary-custom"
              style={{ fontSize: "0.8125rem", padding: "0.35rem 0.85rem" }}
              onClick={handleOpenAdd}
              title={
                selectedFolder
                  ? t("docs.addSubFolderTitle", { name: selectedFolder.name })
                  : t("docs.addRootFolderTitle")
              }
            >
              + {t("docs.folder")}
            </button>
            <button
              className="btn-primary-custom"
              style={{ fontSize: "0.8125rem", padding: "0.35rem 0.85rem" }}
              onClick={handleCreateArticleDirect}
              disabled={createNodeMutation.isPending}
              title={
                selectedFolder
                  ? t("docs.addArticleInTitle", { name: selectedFolder.name })
                  : t("docs.addStandaloneArticleTitle")
              }
            >
              + {t("docs.article")}
            </button>
          </div>
        )}
      </div>

      {/* Case 1: Đang xem một Thư mục cụ thể (Khi click vào mục lớn ở cây thư mục) */}
      {selectedFolder ? (
        <div className="folder-detail-view">
          {/* Header của Thư mục hiện tại */}
          <div className="folder-hero-header">
            <div className="folder-hero-left">
              <span className="folder-hero-icon">📂</span>
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <h1 className="folder-hero-title">{selectedFolder.name}</h1>
                </div>
                <div className="folder-hero-meta">
                  <span>
                    {t("docs.directChildren", { n: selectedFolder.children?.length || 0 })}
                  </span>
                  <span>•</span>
                  <span>
                    {t("docs.totalDescendants", { n: countDescendantsInTree(selectedFolder) })}
                  </span>
                </div>
              </div>
            </div>

            <div
              style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
            >
              {/* Nút Xóa Thư mục hiện tại — Admin Only */}
              {isAdmin && (
                <button
                  className="btn-danger-custom"
                  style={{ fontSize: "0.8125rem", padding: "0.45rem 0.85rem" }}
                  onClick={(e) => handleDeleteNode(selectedFolder, e)}
                  title={t("docs.deleteThisFolderTitle")}
                  disabled={deleteNodeMutation.isPending}
                >
                  🗑️ {t("docs.deleteThisFolder")}
                </button>
              )}

              {/* Nút Quay lại thư mục cha */}
              <button
                className="btn-secondary-custom"
                style={{ fontSize: "0.8125rem", padding: "0.45rem 0.85rem" }}
                onClick={() => {
                  const parent = breadcrumbPath[breadcrumbPath.length - 2];
                  if (parent) navigate(`/documents?folder=${parent.id}`);
                  else navigate("/documents");
                }}
              >
                ↑ {t("docs.parentFolder")}
              </button>
            </div>
          </div>

          {/* Grid các mục con trong Folder (Sub-folders & Articles) */}
          {selectedFolder.children && selectedFolder.children.length > 0 ? (
            <div className="folder-children-grid">
              {selectedFolder.children.map((child) => (
                <div
                  key={child.id}
                  className={`folder-child-card ${child.type} ${child.type === "folder" && child.isProvider ? "is-provider" : ""}`}
                  onClick={() => {
                    if (child.type === "folder") {
                      navigate(`/documents?folder=${child.id}`);
                    } else {
                      navigate(`/wiki/${child.id}`);
                    }
                  }}
                >
                  <div className="child-card-header">
                    <span className="child-card-icon">
                      {child.type === "folder" ? "📁" : "📄"}
                    </span>
                    <div className="child-card-titles">
                      <div className="child-card-name">{child.name}</div>
                      <div className="child-card-tags-row">
                        <span
                          className={`status-badge-pill ${child.status === "draft" ? "draft" : "published"}`}
                        >
                          {child.status === "draft" ? t("docs.statusDraft") : t("docs.statusPublished")}
                        </span>
                        {/* Đánh dấu Folder là Provider (sảnh cược) — Admin Only, chỉ Folder */}
                        {isAdmin && child.type === "folder" && (
                          <button
                            type="button"
                            className={`btn-provider-toggle ${child.isProvider ? "active" : ""}`}
                            onClick={(e) => handleToggleProvider(child, e)}
                            title={
                              child.isProvider
                                ? t("docs.providerOnTitle", { name: child.name })
                                : t("docs.providerOffTitle", { name: child.name })
                            }
                            disabled={setProviderFlagMutation.isPending}
                          >
                            🏷️ {t("docs.provider")}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Nút Xóa nhanh từng mục con — Admin Only */}
                    {isAdmin && (
                      <button
                        type="button"
                        className="btn-card-delete-icon"
                        onClick={(e) => handleDeleteNode(child, e)}
                        title={
                          child.type === "folder"
                            ? t("docs.deleteFolderTitle", { name: child.name })
                            : t("docs.deleteArticleTitle", { name: child.name })
                        }
                        disabled={deleteNodeMutation.isPending}
                      >
                        🗑️
                      </button>
                    )}
                  </div>

                  {child.type === "folder" ? (
                    <div className="child-card-folder-info">
                      <span className="info-chip">
                        📂 {t("docs.subItemsChip", {
                          n: child.children?.length || 0,
                          total: countDescendantsInTree(child),
                        })}
                      </span>
                      <span className="action-hint">{t("docs.openFolder")} →</span>
                    </div>
                  ) : (
                    <div className="child-card-article-preview">
                      <span className="action-hint">{t("docs.readArticle")} →</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="card-custom empty-folder-state">
              <div style={{ fontSize: "3rem", marginBottom: "0.75rem" }}>
                📂
              </div>
              <h3>{t("docs.emptyFolderTitle")}</h3>
              <p style={{ color: "var(--color-text-muted)" }}>
                {t("docs.emptyFolderDesc")}
              </p>
              {isAdmin && (
                <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", justifyContent: "center" }}>
                  <button className="btn-secondary-custom" onClick={handleOpenAdd}>
                    + {t("docs.subFolder")}
                  </button>
                  <button className="btn-primary-custom" onClick={handleCreateArticleDirect}>
                    + {t("docs.newArticle")}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Case 2: Trang chủ Tổng quan (Hiển thị tất cả danh mục gốc) */
        <div className="hub-all-categories-view">
          <div className="hub-hero-banner">
            <div className="hero-content">
              <h1 className="hero-title my-auto">📚 Knowledge Base</h1>
            </div>
          </div>

          {isLoading ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "var(--color-text-muted)" }}>
              ⏳ {t("docs.loadingCategories")}
            </div>
          ) : treeData.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "var(--color-text-muted)" }}>
              📁 {t("docs.noCategories")}
            </div>
          ) : (
            <div className="root-categories-grid mt-5">
              {treeData.map((cat) => (
                <div
                  key={cat.id}
                  className={`root-category-card ${cat.isProvider ? "is-provider" : ""}`}
                  onClick={() => navigate(`/documents?folder=${cat.id}`)}
                >
                  <div className="root-cat-header">
                    <span className="root-cat-icon">📁</span>
                    <div className="root-cat-titles">
                      <h2 className="root-cat-title">{cat.name}</h2>
                    </div>
                    {/* Đánh dấu danh mục gốc là Provider (sảnh cược) — Admin Only */}
                    {isAdmin && (
                      <button
                        type="button"
                        className={`btn-provider-toggle ${cat.isProvider ? "active" : ""}`}
                        onClick={(e) => handleToggleProvider(cat, e)}
                        title={
                          cat.isProvider
                            ? t("docs.providerOnTitle", { name: cat.name })
                            : t("docs.providerOffTitle", { name: cat.name })
                        }
                        disabled={setProviderFlagMutation.isPending}
                      >
                        🏷️ {t("docs.provider")}
                      </button>
                    )}
                    {/* Nút Xóa danh mục gốc — Admin Only */}
                    {isAdmin && (
                      <button
                        type="button"
                        className="btn-card-delete-icon"
                        onClick={(e) => handleDeleteNode(cat, e)}
                        title={t("docs.deleteCategoryTitle", { name: cat.name })}
                        disabled={deleteNodeMutation.isPending}
                      >
                        🗑️
                      </button>
                    )}
                  </div>

                  {cat.children && cat.children.length > 0 && (
                    <div className="root-cat-sublist">
                      {cat.children.slice(0, 4).map((sub) => (
                        <div key={sub.id} className="root-sub-item">
                          <span className="sub-bullet">
                            {sub.type === "folder" ? "📂" : "📄"}
                          </span>
                          <span className="sub-name truncate">{sub.name}</span>
                          {sub.type === "folder" && (
                            <span className="sub-count-tag">
                              {sub.children?.length || 0}
                            </span>
                          )}
                        </div>
                      ))}
                      {cat.children.length > 4 && (
                        <div className="root-more-tag">
                          +{t("docs.moreCategories", { n: cat.children.length - 4 })}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="root-cat-footer">
                    <span className="explore-link">{t("docs.exploreCategory")} →</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modal Thêm Mới Node (Folder hoặc Article) — Admin Only */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div
            className="modal-box-custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header-custom">
              <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 800 }}>
                📁{" "}
                {t("docs.addFolderModalTitle", {
                  target: selectedFolder ? `"${selectedFolder.name}"` : t("docs.home"),
                })}
              </h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowAddModal(false)}
              >
                ✕
              </button>
            </div>

            {formError && (
              <div
                className="alert-box alert-danger"
                style={{ marginTop: "0.75rem" }}
              >
                ⚠️ {formError}
              </div>
            )}

            {/* Tên Thư mục — Article không đi qua modal này (xem handleCreateArticleDirect) */}
            <div style={{ marginTop: "1rem" }}>
              <label className="input-label">{t("docs.folderNameLabel")}</label>
              <input
                type="text"
                className="text-input"
                placeholder={t("docs.folderNamePlaceholder")}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); }}
                autoFocus
              />
            </div>

            <div
              className="modal-footer-custom"
              style={{ marginTop: "1.5rem" }}
            >
              <button
                className="btn-cancel"
                onClick={() => setShowAddModal(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn-primary-custom"
                onClick={handleCreateFolder}
                disabled={createNodeMutation.isPending}
              >
                {createNodeMutation.isPending ? t("docs.creating") : `✓ ${t("docs.createFolder")}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
