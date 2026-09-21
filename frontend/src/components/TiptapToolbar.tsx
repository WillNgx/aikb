import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/react';
import type { CalloutVariant } from '../extensions/Callout';
import { uploadImageFile } from '../utils/uploadImageFile';

// Các bảng màu giữ KHOÁ DỊCH chứ không giữ sẵn câu chữ: nhãn chỉ được dịch lúc render, nếu
// không thì đổi ngôn ngữ giữa chừng sẽ không đổi được tooltip đã dựng từ trước.
export const TEXT_COLORS = [
  { labelKey: 'editor.colors.red', color: '#ef4444' },
  { labelKey: 'editor.colors.blue', color: '#3b82f6' },
  { labelKey: 'editor.colors.green', color: '#10b981' },
  { labelKey: 'editor.colors.orange', color: '#f59e0b' },
  { labelKey: 'editor.colors.purple', color: '#8b5cf6' },
  { labelKey: 'editor.colors.pink', color: '#ec4899' },
  { labelKey: 'editor.colors.white', color: '#ffffff' },
  { labelKey: 'editor.colors.default', color: null },
];

export const HIGHLIGHT_COLORS = [
  { labelKey: 'editor.highlightColors.yellow', bg: '#fef08a' },
  { labelKey: 'editor.highlightColors.green', bg: '#bbf7d0' },
  { labelKey: 'editor.highlightColors.blue', bg: '#bae6fd' },
  { labelKey: 'editor.highlightColors.pink', bg: '#fbcfe8' },
  { labelKey: 'editor.highlightColors.orange', bg: '#fed7aa' },
  { labelKey: 'editor.highlightColors.purple', bg: '#e9d5ff' },
];

const CALLOUT_VARIANTS: { variant: CalloutVariant; labelKey: string }[] = [
  { variant: 'warning', labelKey: 'editor.calloutVariants.warning' },
  { variant: 'danger', labelKey: 'editor.calloutVariants.danger' },
  { variant: 'success', labelKey: 'editor.calloutVariants.success' },
  { variant: 'info', labelKey: 'editor.calloutVariants.info' },
];

const HEADING_OPTIONS: { level: 0 | 1 | 2 | 3; labelKey: string }[] = [
  { level: 0, labelKey: 'editor.headings.paragraph' },
  { level: 1, labelKey: 'editor.headings.h1' },
  { level: 2, labelKey: 'editor.headings.h2' },
  { level: 3, labelKey: 'editor.headings.h3' },
];

const TABLE_HEADER_COLORS = [
  { labelKey: 'editor.headerColors.none', bg: null },
  { labelKey: 'editor.headerColors.cream', bg: '#fef9c3' },
  { labelKey: 'editor.headerColors.mint', bg: '#d1fae5' },
  { labelKey: 'editor.headerColors.blue', bg: '#dbeafe' },
  { labelKey: 'editor.headerColors.pink', bg: '#fce7f3' },
  { labelKey: 'editor.headerColors.orange', bg: '#ffedd5' },
  { labelKey: 'editor.headerColors.purple', bg: '#ede9fe' },
  { labelKey: 'editor.headerColors.gray', bg: '#f1f5f9' },
];

interface TiptapToolbarProps {
  editor: Editor | null;
}

type DropdownKey = 'heading' | 'color' | 'highlight' | 'size' | 'callout' | 'tableHeaderColor' | null;

/**
 * Toolbar cố định (sticky), luôn hiện khi đang Chỉnh sửa — thay cho BubbleMenu nổi khi bôi đen
 * trước đây, khớp trải nghiệm nhập liệu kiểu Word.
 */
export default function TiptapToolbar({ editor }: TiptapToolbarProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState<DropdownKey>(null);
  const [fontSizeInput, setFontSizeInput] = useState('15');
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Ép re-render mỗi khi có transaction (kể cả transaction CHỈ đổi selection, không đổi nội
  // dung — vd bấm chuột di chuyển con trỏ vào/ra khỏi 1 bảng) — nếu không, các trạng thái suy
  // ra trực tiếp từ editor (is-active, nhãn Heading hiện tại, dải nút bảng hiện/ẩn) sẽ đứng yên
  // theo lần render trước đó cho tới khi người dùng thực sự gõ gì đó.
  const [, forceRerender] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => forceRerender((n) => n + 1);
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  if (!editor) return null;

  const handleFontSizeApply = () => {
    const size = parseInt(fontSizeInput, 10);
    if (!size || size < 1 || size > 200) return;
    editor.chain().focus().setMark('textStyle', { fontSize: `${size}px` }).run();
    setOpenDropdown(null);
  };

  const currentHeadingLevel = editor.isActive('heading', { level: 1 })
    ? 1
    : editor.isActive('heading', { level: 2 })
      ? 2
      : editor.isActive('heading', { level: 3 })
        ? 3
        : 0;
  const currentHeadingLabel = t(HEADING_OPTIONS.find((h) => h.level === currentHeadingLevel)!.labelKey);

  const isCalloutActive = editor.isActive('callout');
  const currentCalloutVariant = (editor.getAttributes('callout').variant as CalloutVariant) || 'warning';

  const handleCalloutVariantClick = (variant: CalloutVariant) => {
    if (isCalloutActive) {
      editor.chain().focus().updateCalloutVariant(variant).run();
    } else {
      editor.chain().focus().setCallout(variant).run();
    }
    setOpenDropdown(null);
  };

  // Dải nút thao tác bảng (+Hàng/+Cột/xóa/màu tiêu đề) chỉ hiện khi con trỏ đang ở trong 1 bảng.
  const isTableActive = editor.isActive('table');

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // cho phép chọn lại cùng 1 file lần sau
    if (!file) return;
    setIsUploadingImage(true);
    setImageUploadError(null);
    try {
      const url = await uploadImageFile(file);
      editor.chain().focus().setImage({ src: url }).run();
    } catch (err: any) {
      setImageUploadError(err.message || t('editor.imageUploadFailed'));
    } finally {
      setIsUploadingImage(false);
    }
  };

  return (
    <div className="tiptap-toolbar" ref={toolbarRef}>
      <div className="tiptap-btn-group">

        {/* Heading / Đoạn văn thường */}
        <div className="tiptap-dropdown-wrap">
          <button
            type="button"
            title={t('editor.headingTitle')}
            aria-label={t('editor.headingTitle')}
            className={`tiptap-btn btn-heading ${openDropdown === 'heading' ? 'is-open' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenDropdown(openDropdown === 'heading' ? null : 'heading'); }}
          >
            <span className="tiptap-btn-label">{currentHeadingLabel}</span>
            <span className="dropdown-caret">▾</span>
          </button>
          {openDropdown === 'heading' && (
            <div className="tiptap-dropdown-menu heading-menu">
              <div className="dropdown-menu-title">{t('editor.blockStyle')}</div>
              {HEADING_OPTIONS.map((h) => (
                <button
                  key={h.level}
                  type="button"
                  className={`popover-item-btn ${currentHeadingLevel === h.level ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (h.level === 0) editor.chain().focus().setParagraph().run();
                    else editor.chain().focus().toggleHeading({ level: h.level }).run();
                    setOpenDropdown(null);
                  }}
                >
                  {t(h.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tiptap-divider" />

        {/* Bold */}
        <button
          type="button"
          title={t('editor.bold')}
          className={`tiptap-btn btn-bold ${editor.isActive('bold') ? 'is-active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
        >
          <strong>B</strong>
        </button>

        {/* Italic */}
        <button
          type="button"
          title={t('editor.italic')}
          className={`tiptap-btn btn-italic ${editor.isActive('italic') ? 'is-active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
        >
          <em>I</em>
        </button>

        {/* Underline */}
        <button
          type="button"
          title={t('editor.underline')}
          className={`tiptap-btn btn-underline ${editor.isActive('underline') ? 'is-active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }}
        >
          <span style={{ textDecoration: 'underline' }}>U</span>
        </button>

        <div className="tiptap-divider" />

        {/* Màu chữ */}
        <div className="tiptap-dropdown-wrap">
          <button
            type="button"
            title={t('editor.textColorTitle')}
            className={`tiptap-btn btn-color ${openDropdown === 'color' ? 'is-open' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenDropdown(openDropdown === 'color' ? null : 'color'); }}
          >
            <span className="color-indicator" style={{
              background: editor.getAttributes('textStyle').color || 'var(--color-text)',
              width: 12, height: 12, borderRadius: '50%', display: 'inline-block', border: '1.5px solid rgba(0,0,0,0.15)'
            }} />
            <span className="tiptap-btn-label">{t('editor.textColor')}</span>
            <span className="dropdown-caret">▾</span>
          </button>
          {openDropdown === 'color' && (
            <div className="tiptap-dropdown-menu color-menu">
              <div className="dropdown-menu-title">{t('editor.textColor')}</div>
              <div className="color-grid">
                {TEXT_COLORS.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    className="color-swatch-btn"
                    title={t(c.labelKey)}
                    style={{ background: c.color ?? 'transparent', border: c.color ? undefined : '1.5px dashed #ccc' }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (c.color) {
                        editor.chain().focus().setColor(c.color).run();
                      } else {
                        editor.chain().focus().unsetColor().run();
                      }
                      setOpenDropdown(null);
                    }}
                  >
                    {!c.color && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>∅</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Highlight */}
        <div className="tiptap-dropdown-wrap">
          <button
            type="button"
            title={t('editor.highlightTitle')}
            className={`tiptap-btn btn-highlight ${openDropdown === 'highlight' ? 'is-open' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenDropdown(openDropdown === 'highlight' ? null : 'highlight'); }}
          >
            🖍️
            <span className="tiptap-btn-label">{t('editor.highlight')}</span>
            <span className="dropdown-caret">▾</span>
          </button>
          {openDropdown === 'highlight' && (
            <div className="tiptap-dropdown-menu highlight-menu">
              <div className="dropdown-menu-title">{t('editor.highlightMenuTitle')}</div>
              <div className="color-grid">
                {HIGHLIGHT_COLORS.map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    className="color-swatch-btn"
                    title={t(h.labelKey)}
                    style={{ background: h.bg }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      editor.chain().focus().toggleHighlight({ color: h.bg }).run();
                      setOpenDropdown(null);
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="color-swatch-btn"
                  title={t('editor.removeHighlight')}
                  style={{ border: '1.5px dashed #ccc' }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    editor.chain().focus().unsetHighlight().run();
                    setOpenDropdown(null);
                  }}
                >
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>∅</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Font Size */}
        <div className="tiptap-dropdown-wrap">
          <button
            type="button"
            title={t('editor.fontSize')}
            className={`tiptap-btn btn-size ${openDropdown === 'size' ? 'is-open' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenDropdown(openDropdown === 'size' ? null : 'size'); }}
          >
            🔤
            <span className="tiptap-btn-label">{t('editor.fontSize')}</span>
            <span className="dropdown-caret">▾</span>
          </button>
          {openDropdown === 'size' && (
            <div className="tiptap-dropdown-menu size-menu">
              <div className="dropdown-menu-title">{t('editor.fontSizeMenuTitle')}</div>
              <div className="font-size-input-row">
                <input
                  type="number"
                  className="font-size-number-input"
                  min={1}
                  max={200}
                  value={fontSizeInput}
                  onChange={(e) => setFontSizeInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleFontSizeApply(); }}
                  autoFocus
                />
                <span className="font-size-unit">px</span>
                <button
                  type="button"
                  className="font-size-apply-btn"
                  onMouseDown={(e) => { e.preventDefault(); handleFontSizeApply(); }}
                >
                  {t('editor.apply')}
                </button>
              </div>
              <div className="font-size-presets">
                {[12, 14, 16, 18, 20, 24, 28, 32, 36, 48].map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="font-size-preset-btn"
                    style={{ fontSize: Math.min(s, 22) + 'px' }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      editor.chain().focus().setMark('textStyle', { fontSize: `${s}px` }).run();
                      setFontSizeInput(String(s));
                      setOpenDropdown(null);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="tiptap-divider" />

        {/* Callout (Cảnh báo / Đặc biệt) */}
        <div className="tiptap-dropdown-wrap">
          <button
            type="button"
            title={t('editor.calloutTitle')}
            className={`tiptap-btn btn-callout ${isCalloutActive ? 'is-active' : ''} ${openDropdown === 'callout' ? 'is-open' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenDropdown(openDropdown === 'callout' ? null : 'callout'); }}
          >
            📌
            <span className="tiptap-btn-label">{t('editor.callout')}</span>
            <span className="dropdown-caret">▾</span>
          </button>
          {openDropdown === 'callout' && (
            <div className="tiptap-dropdown-menu callout-menu">
              <div className="dropdown-menu-title">
                {isCalloutActive ? t('editor.changeCalloutColor') : t('editor.insertCallout')}
              </div>
              <div className="callout-color-picker">
                {CALLOUT_VARIANTS.map((v) => (
                  <button
                    key={v.variant}
                    type="button"
                    className={`color-dot-btn ${v.variant} ${isCalloutActive && currentCalloutVariant === v.variant ? 'active' : ''}`}
                    title={t(v.labelKey)}
                    onMouseDown={(e) => { e.preventDefault(); handleCalloutVariantClick(v.variant); }}
                  />
                ))}
              </div>
              {isCalloutActive && (
                <button
                  type="button"
                  className="popover-item-btn"
                  style={{ marginTop: '0.5rem' }}
                  onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().unsetCallout().run(); setOpenDropdown(null); }}
                >
                  ✕ {t('editor.removeCallout')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Bảng */}
        <button
          type="button"
          title={t('editor.insertTable')}
          className="tiptap-btn btn-table"
          onMouseDown={(e) => {
            e.preventDefault();
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          }}
        >
          📊 <span className="tiptap-btn-label">{t('editor.table')}</span>
        </button>

        {/* Thao tác bảng — chỉ hiện khi con trỏ đang ở trong 1 bảng */}
        {isTableActive && (
          <>
            <div className="tiptap-divider" />
            <button
              type="button"
              title={t('editor.addRowTitle')}
              className="tiptap-btn btn-table-action"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowAfter().run(); }}
            >
              {t('editor.addRow')}
            </button>
            <button
              type="button"
              title={t('editor.addColumnTitle')}
              className="tiptap-btn btn-table-action"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnAfter().run(); }}
            >
              {t('editor.addColumn')}
            </button>
            <button
              type="button"
              title={t('editor.deleteRowTitle')}
              className="tiptap-btn btn-table-action"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteRow().run(); }}
            >
              🗑{t('editor.deleteRow')}
            </button>
            <button
              type="button"
              title={t('editor.deleteColumnTitle')}
              className="tiptap-btn btn-table-action"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteColumn().run(); }}
            >
              🗑{t('editor.deleteColumn')}
            </button>

            {/* Gộp / Tách ô.
                Dùng mergeOrSplit (lệnh 2-trong-1 của prosemirror-tables): đang bôi đen nhiều ô
                thì gộp, đang đứng trong 1 ô đã gộp thì tách — người dùng không phải nhớ 2 nút.
                Nút tự mờ đi khi con trỏ ở vị trí không gộp/tách được, để không bấm hụt. */}
            <button
              type="button"
              title={t('editor.mergeSplitTitle')}
              className="tiptap-btn btn-table-action"
              disabled={!editor.can().chain().focus().mergeOrSplit().run()}
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().mergeOrSplit().run(); }}
            >
              ⛶ <span className="tiptap-btn-label">{t('editor.mergeSplit')}</span>
            </button>

            {/* Màu hàng tiêu đề */}
            <div className="tiptap-dropdown-wrap">
              <button
                type="button"
                title={t('editor.headerColorTitle')}
                className={`tiptap-btn btn-table-action ${openDropdown === 'tableHeaderColor' ? 'is-open' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); setOpenDropdown(openDropdown === 'tableHeaderColor' ? null : 'tableHeaderColor'); }}
              >
                🎨 <span className="tiptap-btn-label">{t('editor.headerColor')}</span>
                <span className="dropdown-caret">▾</span>
              </button>
              {openDropdown === 'tableHeaderColor' && (
                <div className="tiptap-dropdown-menu bgcolor-menu">
                  <div className="dropdown-menu-title">{t('editor.headerColorMenuTitle')}</div>
                  <div className="color-grid">
                    {TABLE_HEADER_COLORS.map((c, i) => (
                      <button
                        key={i}
                        type="button"
                        className="color-swatch-btn"
                        title={t(c.labelKey)}
                        style={{ background: c.bg ?? 'transparent', border: c.bg ? undefined : '1.5px dashed #ccc' }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          editor.chain().focus().setTableHeaderColor(c.bg).run();
                          setOpenDropdown(null);
                        }}
                      >
                        {!c.bg && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>∅</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              title={t('editor.deleteTableTitle')}
              className="tiptap-btn btn-table-action btn-table-delete"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteTable().run(); }}
            >
              🗑 <span className="tiptap-btn-label">{t('editor.deleteTable')}</span>
            </button>
          </>
        )}

        {/* Ảnh */}
        <button
          type="button"
          title={t('editor.insertImage')}
          aria-label={t('editor.insertImage')}
          className="tiptap-btn btn-image"
          disabled={isUploadingImage}
          onClick={(e) => { e.preventDefault(); imageInputRef.current?.click(); }}
        >
          {isUploadingImage ? '⏳' : '🖼️'} <span className="tiptap-btn-label">{isUploadingImage ? t('editor.uploading') : t('editor.image')}</span>
        </button>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          ref={imageInputRef}
          onChange={handleImageFileChange}
          style={{ display: 'none' }}
        />

      </div>
      {imageUploadError && <div className="tiptap-toolbar-error">⚠️ {imageUploadError}</div>}
    </div>
  );
}
