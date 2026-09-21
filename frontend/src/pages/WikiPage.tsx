import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  useNodeQuery,
  useUpdateNode,
  usePublishNode,
  useDeleteNode,
  useTreeQuery,
  getPathToNode,
} from "../hooks/useTree";
import { useAuthUser, nodesApi } from "../api";
import type { TreeNodeDTO } from "../api";
import type { TiptapDoc, TocItem } from "../data/docModel";
import { extractTocFromDoc, normalizeDoc, createEmptyDoc, isEmptyDoc } from "../data/docModel";
import TiptapEditor from "../components/TiptapEditor";
import BackToTopButton from "../components/BackToTopButton";
import { useConfirm, useAlert } from "../components/ConfirmModal";
import "../styles/wikiArticle.css";

export default function WikiPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin } = useAuthUser();
  const confirm = useConfirm();
  const thongBao = useAlert();
  const { t, i18n } = useTranslation();

  // Queries
  const { data: treeData = [] } = useTreeQuery();
  const { data: currentNode, isLoading, isError } = useNodeQuery(id);

  // Mutations
  const updateNodeMutation = useUpdateNode();
  const publishNodeMutation = usePublishNode();
  const deleteNodeMutation = useDeleteNode();

  const path: TreeNodeDTO[] = id ? getPathToNode(id, treeData) || [] : [];
  const contentTitle = currentNode ? currentNode.name : "";
  const isDraft = currentNode?.status === "draft";

  // Tài liệu TipTap hiện tại của Article (1 doc liên tục, thay cho cây BlockNode cũ)
  const currentDoc: TiptapDoc = useMemo(() => normalizeDoc(currentNode?.body), [currentNode]);

  // ─── Edit Mode States (Admin Only) ─────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDoc, setEditDoc] = useState<TiptapDoc>(createEmptyDoc());
  const [toastMsg, setToastMsg] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  // Khởi tạo form khi bật Edit Mode
  const startEditMode = () => {
    setEditName(contentTitle);
    setEditDoc(JSON.parse(JSON.stringify(currentDoc)));
    setIsEditing(true);
  };

  // Bài viết mới tạo (chưa từng Lưu/Đăng lần nào) → theo Folio Workflow Spec, mở thẳng vào
  // Chỉnh sửa ngay khi tải xong, không cần bấm "Chỉnh sửa" trước, con trỏ focus sẵn vào tên.
  useEffect(() => {
    if (currentNode && !currentNode.hasBeenSaved) {
      setEditName(currentNode.name);
      setEditDoc(JSON.parse(JSON.stringify(normalizeDoc(currentNode.body))));
      setIsEditing(true);
      setTimeout(() => titleInputRef.current?.focus(), 0);
    }
    // Chỉ chạy lại khi chuyển sang xem 1 node khác — không phụ thuộc isEditing/currentDoc để
    // tránh tự bật lại Edit ngay sau khi người dùng chủ động Hủy/Lưu/Đăng.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNode?.id]);

  // ─── Auto-save khi rời trang giữa chừng lúc đang Chỉnh sửa ─────────────────
  // Refs luôn giữ giá trị mới nhất để cleanup (chạy lúc unmount, không phải lúc effect được
  // tạo) đọc đúng state cuối cùng thay vì closure cũ.
  const isEditingRef = useRef(isEditing);
  const editNameRef = useRef(editName);
  const editDocRef = useRef(editDoc);
  const hasBeenSavedRef = useRef(currentNode?.hasBeenSaved ?? false);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  useEffect(() => { editNameRef.current = editName; }, [editName]);
  useEffect(() => { editDocRef.current = editDoc; }, [editDoc]);
  useEffect(() => { hasBeenSavedRef.current = currentNode?.hasBeenSaved ?? false; }, [currentNode?.hasBeenSaved]);

  useEffect(() => {
    // Đóng/refresh tab thật (không phải điều hướng trong app) chỉ có thể cảnh báo native —
    // không thể tự lưu đáng tin cậy ở đây (không có cách gắn Authorization header qua sendBeacon).
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isEditingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    // Điều hướng trong app (sidebar/breadcrumb/back) → unmount xảy ra thật (nhờ key={id} ở
    // App.tsx) → coi như vừa bấm "Lưu", TRỪ 1 bài viết mới tạo còn nguyên trạng thái ban đầu
    // (chưa gõ gì) → xóa hẳn thay vì để lại 1 draft rỗng vĩnh viễn.
    return () => {
      if (!isEditingRef.current || !id) return;
      const isPristineNewArticle =
        !hasBeenSavedRef.current &&
        editNameRef.current.trim() === "" &&
        isEmptyDoc(editDocRef.current);
      if (isPristineNewArticle) {
        nodesApi.delete(id).catch(() => {});
      } else {
        nodesApi.update(id, { name: editNameRef.current.trim(), body: editDocRef.current }).catch(() => {});
      }
    };
  }, [id]);

  // Hủy bỏ phiên edit: nếu bài viết CHƯA TỪNG Lưu/Đăng lần nào thì không có gì để quay lại —
  // xóa hẳn (theo Folio Workflow Spec). Ngược lại chỉ thoát Edit mode như cũ, bỏ thay đổi.
  // BẮT BUỘC xác nhận trước khi thực hiện — trước đây bấm phát ăn ngay (kể cả xóa vĩnh viễn),
  // nên chỉ cần Tab nhảy lung tung lỡ rơi đúng nút này rồi bấm Enter/Space tiếp là mất trắng
  // dữ liệu đang nhập, không có cách nào lấy lại.
  const handleCancelEdit = async () => {
    const isNeverSaved = Boolean(currentNode && !currentNode.hasBeenSaved && id);
    const confirmMsg = isNeverSaved
      ? t("wiki.confirmCancelNewArticle")
      : t("wiki.confirmDiscardChanges");

    if (!(await confirm(confirmMsg))) return;

    if (isNeverSaved && id) {
      deleteNodeMutation.mutate(id, {
        onSuccess: (res) => {
          navigate(res.parentId ? `/documents?folder=${res.parentId}` : "/documents");
        },
        onError: (err: any) => {
          thongBao(err?.response?.data?.error || t("wiki.cancelNewArticleFailed"));
        },
      });
      return;
    }
    setIsEditing(false);
    showToast(t("wiki.changesDiscarded"));
  };

  // Lưu phiên edit dưới dạng DRAFT -> thoát edit mode
  const handleSaveDraft = () => {
    if (!id || !currentNode) return;
    if (!editName.trim()) {
      thongBao(t("wiki.titleRequired"));
      return;
    }

    updateNodeMutation.mutate(
      {
        id,
        data: {
          name: editName.trim(),
          body: editDoc,
        },
      },
      {
        onSuccess: () => {
          setIsEditing(false);
          showToast(t("wiki.savedAsDraft"));
        },
        onError: (err: any) => {
          thongBao(err?.response?.data?.error || t("wiki.saveDraftFailed"));
        },
      }
    );
  };

  // Đăng (Publish) bản Draft thành bản chính thức.
  // Backend tự động re-index ngay khi publish (DEC-02) — không cần FE gọi thêm API reindex riêng.
  const handlePublish = async () => {
    if (!id) return;
    publishNodeMutation.mutate(id, {
      onSuccess: () => {
        showToast(`🚀 ${t("wiki.published")}`);
      },
      onError: (err: any) => {
        showToast(t("wiki.publishFailed", { error: err?.response?.data?.error || t("wiki.failed") }));
      },
    });
  };

  // Xóa bài viết vĩnh viễn khỏi hệ thống — Admin Only
  const handleDeleteArticle = async () => {
    if (!id || !currentNode) return;
    if (await confirm(t("wiki.confirmDeleteArticle", { name: contentTitle }))) {
      deleteNodeMutation.mutate(id, {
        onSuccess: (res) => {
          showToast(t("wiki.articleDeleted", { name: contentTitle }));
          if (res.parentId) {
            navigate(`/documents?folder=${res.parentId}`);
          } else {
            navigate("/documents");
          }
        },
        onError: (err: any) => {
          thongBao(err?.response?.data?.error || t("wiki.deleteArticleFailed"));
        },
      });
    }
  };

  // Trích xuất Mục lục TOC tự động từ doc
  const extractedToc: TocItem[] = useMemo(() => {
    const activeDoc = isEditing ? editDoc : currentDoc;
    return extractTocFromDoc(activeDoc);
  }, [isEditing, editDoc, currentDoc]);

  // Handle hash scrolling when mounting or URL hash change
  useEffect(() => {
    if (location.hash && !isEditing) {
      const anchorId = location.hash.replace("#", "");
      setTimeout(() => {
        const el = document.getElementById(anchorId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("heading-highlight-flash");
          setTimeout(
            () => el.classList.remove("heading-highlight-flash"),
            1800
          );
        }
      }, 200);
    }
  }, [location.hash, id, isEditing]);

  const scrollToHeading = (anchorId: string, e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(anchorId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("heading-highlight-flash");
      setTimeout(() => el.classList.remove("heading-highlight-flash"), 1800);
      window.history.replaceState(null, "", `#${anchorId}`);
    }
  };

  if (isLoading) {
    return (
      <div className="loading-state-container">
        <div className="spinner-custom" />
        <p>{t("wiki.loading")}</p>
      </div>
    );
  }

  if (isError || !currentNode) {
    return (
      <div className="empty-state-card">
        <div className="empty-icon">📭</div>
        <h2>{t("wiki.notFoundTitle")}</h2>
        <p>{t("wiki.notFoundDesc")}</p>
        <button
          className="btn-primary-custom"
          onClick={() => navigate("/documents")}
        >
          ← {t("wiki.backToDocuments")}
        </button>
      </div>
    );
  }

  return (
    <div className="wiki-page-container">
      {/* Toast */}
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
          {toastMsg}
        </div>
      )}

      {/* Breadcrumb path theo Canva.md */}
      <div
        className="wiki-breadcrumb"
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
            gap: "0.4rem",
            flexWrap: "wrap",
          }}
        >
          <span className="crumb-item" onClick={() => navigate("/documents")}>
            🏠 {t("docs.home")}
          </span>
          {path.map((node, i) => {
            const isLast = i === path.length - 1;
            return (
              <span
                key={node.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                <span className="crumb-sep">/</span>
                {isLast ? (
                  <span className="crumb-active">{node.name}</span>
                ) : (
                  <span
                    className="crumb-item"
                    onClick={() => {
                      if (node.type === "folder")
                        navigate(`/documents?folder=${node.id}`);
                      else navigate(`/wiki/${node.id}`);
                    }}
                  >
                    {node.type === "folder" ? "📁" : "📄"} {node.name}
                  </span>
                )}
              </span>
            );
          })}
        </div>

        {/* Nút Edit & Delete — Chỉ Admin mới thấy, chỉ ở chế độ Xem */}
        {isAdmin && !isEditing && (
          <div
            className="wiki-admin-top-actions"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <button
              className="btn-danger-custom"
              style={{ padding: "0.35rem 0.85rem", fontSize: "0.8125rem" }}
              onClick={handleDeleteArticle}
              title={t("wiki.deleteArticleTitle")}
              disabled={deleteNodeMutation.isPending}
            >
              🗑️ {t("wiki.deleteArticle")}
            </button>
            <button
              className="btn-primary-custom"
              style={{ padding: "0.35rem 0.85rem", fontSize: "0.8125rem" }}
              onClick={startEditMode}
            >
              ✏️ {t("wiki.editArticle")}
            </button>
          </div>
        )}
      </div>

      {/* Draft Notification Bar (Khi có bản Draft và không đang trong Edit Mode) */}
      {isAdmin && isDraft && !isEditing && (
        <div className="draft-alert-bar">
          <div className="draft-alert-left">
            <span className="draft-badge-tag">{t("wiki.draftTag")}</span>
            <span className="draft-alert-text">{t("wiki.draftNotice")}</span>
          </div>
          <div className="draft-alert-actions">
            <button
              className="btn-publish-custom"
              onClick={handlePublish}
              disabled={publishNodeMutation.isPending}
              title={t("wiki.publishTitle")}
              aria-label={t("wiki.publishTitle")}
            >
              {publishNodeMutation.isPending ? `⏳ ${t("wiki.publishing")}` : `🚀 ${t("wiki.publish")}`}
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="wiki-content-grid">
        {/* Main Article Card (Dùng chung 1 layout hiển thị cho cả View và Edit) */}
        <article className="wiki-article-card">
          {/* Header Thông tin chung */}
          <header
            className="wiki-header"
            style={{
              marginBottom: "1.5rem",
              borderBottom: "1px solid var(--color-border)",
              paddingBottom: "1rem",
            }}
          >
            {isEditing ? (
              <div className="edit-header-box">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "1rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    <span style={{ fontSize: "1.25rem" }}>✏️</span>
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "1.15rem",
                        fontWeight: 800,
                      }}
                    >
                      {t("wiki.editArticle")}
                    </h2>
                  </div>
                </div>

                <div>
                  <label className="input-label">{t("wiki.articleTitleLabel")}</label>
                  <input
                    type="text"
                    ref={titleInputRef}
                    className="text-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder={t("wiki.articleTitlePlaceholder")}
                    style={{ fontWeight: 800, fontSize: "1.15rem" }}
                  />
                </div>
              </div>
            ) : (
              <>
                <h1 className="wiki-article-title">{contentTitle}</h1>
                <div className="wiki-meta-row">
                  <span
                    className={`meta-badge ${isDraft ? "status-draft" : "status-published"}`}
                  >
                    {isDraft ? `📝 ${t("wiki.draftBadge")}` : `✅ ${t("wiki.publishedBadge")}`}
                  </span>
                  <span className="meta-badge">
                    📅 {t("wiki.updatedAt")}:{" "}
                    {new Date(currentNode.updatedAt).toLocaleDateString(
                      i18n.language === "en" ? "en-GB" : "vi-VN"
                    )}
                  </span>
                </div>
              </>
            )}
          </header>

          {/* Nội dung bài viết — 1 tài liệu TipTap liên tục, kiểu soạn thảo Word */}
          <div className="wiki-body-content">
            <TiptapEditor
              value={isEditing ? editDoc : currentDoc}
              onChange={isEditing ? setEditDoc : () => {}}
              editable={isEditing}
            />
          </div>

          {/* Footer nút hành động khi ở Edit Mode */}
          {isEditing && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.75rem",
                marginTop: "2rem",
                paddingTop: "1rem",
                borderTop: "1px solid var(--color-border)",
              }}
            >
              <button className="btn-cancel" onClick={handleCancelEdit}>
                ❌ {t("common.cancel")}
              </button>
              <button
                className="btn-primary-custom"
                onClick={handleSaveDraft}
                disabled={updateNodeMutation.isPending}
              >
                {updateNodeMutation.isPending ? t("wiki.saving") : `💾 ${t("wiki.saveDraft")}`}
              </button>
            </div>
          )}
        </article>

        {/* In-page Table of Contents (TOC) — Tự động đồng bộ với các Heading trong Cây Block.
            Hiện từ 992px (d-lg-block) thay vì 1200px (d-xl-block): laptop 13" phổ biến chỉ
            rộng 1024–1280px, ở ngưỡng cũ nhiều máy mất hẳn mục lục dù màn hình vẫn đủ chỗ.
            Ngưỡng này phải khớp với media query của .wiki-content-grid trong index.css. */}
        {extractedToc.length > 0 && (
          <aside className="wiki-toc-sidebar d-none d-lg-block">
            <div className="toc-card">
              <div className="toc-title">
                <span>📑 {t("wiki.tableOfContents")}</span>
              </div>
              <nav className="toc-nav">
                {extractedToc.map((item) => (
                  <div key={item.id} className="toc-item-group">
                    <a
                      href={`#${item.id}`}
                      className={`toc-link ${item.level === 1 ? "h1-link" : item.level === 2 ? "h2-link" : "sub-link"}`}
                      onClick={(e) => scrollToHeading(item.id, e)}
                    >
                      {item.level === 1
                        ? "📌 "
                        : item.level === 2
                          ? "🔹 "
                          : "▪️ "}
                      {item.title}
                    </a>
                    {item.subItems && item.subItems.length > 0 && (
                      <div className="toc-sub-list">
                        {item.subItems.map((sub) => (
                          <div
                            key={sub.id}
                            className="toc-item-group"
                          >
                            <a
                              href={`#${sub.id}`}
                              className={`toc-link ${sub.level === 2 ? "h2-link" : "sub-link"}`}
                              onClick={(e) => scrollToHeading(sub.id, e)}
                            >
                              {sub.level === 2 ? "🔹 " : "▪️ "}
                              {sub.title}
                            </a>
                            {sub.subItems && sub.subItems.length > 0 && (
                              <div className="toc-sub-list">
                                {sub.subItems.map((st: any) => (
                                  <a
                                    key={st.id}
                                    href={`#${st.id}`}
                                    className="toc-link sub-link"
                                    onClick={(e) => scrollToHeading(st.id, e)}
                                  >
                                    ▪️ {st.title}
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </nav>
            </div>
          </aside>
        )}
      </div>

      <BackToTopButton />
    </div>
  );
}
