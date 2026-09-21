import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type ConfirmFn = (message: string, options?: ConfirmOptions) => Promise<boolean>;
/** Thay cho window.alert(): chỉ báo tin, không hỏi lựa chọn. */
type AlertFn = (message: string, options?: { title?: string; closeLabel?: string }) => Promise<void>;

interface DialogApi {
  confirm: ConfirmFn;
  alert: AlertFn;
}

const ConfirmContext = createContext<DialogApi | null>(null);

/** Thay thế window.confirm(): await confirm("...") trả về true/false theo nút người dùng bấm. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm phải được dùng bên trong ConfirmProvider");
  return ctx.confirm;
}

/**
 * Thay thế window.alert(). Dùng chung hộp thoại với useConfirm nên hiển thị đúng theme,
 * đúng bộ màu, và không chặn toàn bộ trình duyệt như alert() gốc.
 */
export function useAlert(): AlertFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useAlert phải được dùng bên trong ConfirmProvider");
  return ctx.alert;
}

/** Các phần tử có thể nhận focus bên trong hộp thoại — dùng cho focus trap. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface DialogState {
  message: string;
  options: ConfirmOptions;
  /** true = chỉ báo tin (một nút), false = hỏi xác nhận (hai nút) */
  chiBaoTin: boolean;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<DialogState | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Phần tử đang focus TRƯỚC khi mở hộp thoại — để trả focus về đúng chỗ sau khi đóng. */
  const focusTruocRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmFn>((message, options = {}) => {
    setState({ message, options, chiBaoTin: false });
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const alert = useCallback<AlertFn>((message, options = {}) => {
    setState({
      message,
      options: { title: options.title ?? t("common.notice"), cancelLabel: options.closeLabel ?? t("common.understood") },
      chiBaoTin: true,
    });
    return new Promise<void>((resolve) => {
      resolveRef.current = () => resolve();
    });
    // `t` phải nằm trong dependency: đổi KB là đổi ngôn ngữ, nếu giữ mảng rỗng thì hộp thoại
    // vẫn dùng bản dịch của ngôn ngữ lúc component mount.
  }, [t]);

  const close = useCallback((result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setState(null);
  }, []);

  // ─── Bàn phím: Escape để đóng + Tab bị giữ lại trong hộp thoại (focus trap) ──────────
  // Không có phần này thì Tab vẫn nhảy ra các nút phía sau lớp nền — rất nguy hiểm với hộp
  // thoại xác nhận xoá vĩnh viễn, vì người dùng bàn phím không biết mình đang bấm cái gì.
  useEffect(() => {
    if (!state) return;

    focusTruocRef.current = document.activeElement as HTMLElement | null;

    // Focus mặc định vào nút Huỷ, KHÔNG phải nút ✕ hay nút xác nhận — tránh việc Enter theo
    // quán tính lại kích hoạt luôn hành động phá huỷ dữ liệu.
    // Phải LỌC bằng JS chứ không nối ":not(.modal-close-btn)" vào chuỗi FOCUSABLE: chuỗi đó
    // là danh sách nhiều selector ngăn cách bởi dấu phẩy, nối thêm vào chỉ áp cho selector
    // CUỐI CÙNG nên nút ✕ vẫn lọt qua.
    const dsFocus = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const nutHuy = dsFocus.find((el) => !el.classList.contains("modal-close-btn"));
    (nutHuy ?? dsFocus[0])?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
        return;
      }
      if (e.key !== "Tab" || !boxRef.current) return;

      const items = Array.from(boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const dau = items[0];
      const cuoi = items[items.length - 1];

      if (e.shiftKey && document.activeElement === dau) {
        e.preventDefault();
        cuoi.focus();
      } else if (!e.shiftKey && document.activeElement === cuoi) {
        e.preventDefault();
        dau.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Trả focus về nơi người dùng đang đứng trước khi hộp thoại mở ra
      focusTruocRef.current?.focus?.();
    };
  }, [state, close]);

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      {state && (
        <div className="modal-overlay" onClick={() => close(false)}>
          <div
            ref={boxRef}
            className="modal-box-custom"
            style={{ maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            aria-describedby="dialog-message"
          >
            <div className="modal-header-custom">
              <h3 id="dialog-title" style={{ margin: 0, fontSize: "var(--fs-md)", fontWeight: 800 }}>
                {state.options.title ?? t("common.confirm")}
              </h3>
              <button className="modal-close-btn" onClick={() => close(false)} aria-label={t("common.closeDialog")}>
                ✕
              </button>
            </div>
            <div
              id="dialog-message"
              style={{ marginTop: "1rem", fontSize: "var(--fs-base)", color: "var(--color-text)" }}
            >
              {state.message}
            </div>
            <div className="modal-footer-custom" style={{ marginTop: "1.5rem" }}>
              <button className="btn-cancel" onClick={() => close(false)}>
                {state.options.cancelLabel ?? t("common.cancel")}
              </button>
              {!state.chiBaoTin && (
                <button className="btn-danger-custom" onClick={() => close(true)}>
                  {state.options.confirmLabel ?? t("common.confirm")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
