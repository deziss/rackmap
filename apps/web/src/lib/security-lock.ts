/**
 * Security lock — disables text selection, right-click, copy/cut shortcuts,
 * and DevTools shortcuts everywhere except form elements.
 * Activated only when VITE_SECURITY_LOCK=true at build time.
 */

function isFormTarget(e: Event): boolean {
  const t = e.target as Element | null;
  if (!t) return false;
  const tag = t.tagName.toLowerCase();
  if (["input", "textarea", "select", "option"].includes(tag)) return true;
  if (t.closest('[contenteditable="true"]')) return true;
  return false;
}

export function initSecurityLock() {
  // 1. CSS: kill user-select everywhere; restore inside form elements
  const style = document.createElement("style");
  style.dataset.securityLock = "1";
  style.textContent = [
    "*, *::before, *::after {",
    "  user-select: none !important;",
    "  -webkit-user-select: none !important;",
    "}",
    "input, textarea, select, [contenteditable] {",
    "  user-select: text !important;",
    "  -webkit-user-select: text !important;",
    "}",
  ].join("\n");
  document.head.appendChild(style);

  // 2. Block right-click (contextmenu)
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!isFormTarget(e)) e.preventDefault();
    },
    true,
  );

  // 3. Block copy/cut/select-all/save/view-source + DevTools shortcuts
  document.addEventListener(
    "keydown",
    (e) => {
      if (isFormTarget(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        const k = e.key.toLowerCase();
        // copy, cut, select-all, save, view-source
        if (["c", "x", "a", "s", "u"].includes(k)) {
          e.preventDefault();
          return;
        }
        // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C (DevTools)
        if (e.shiftKey && ["i", "j", "c"].includes(k)) {
          e.preventDefault();
          return;
        }
      }
      // F12
      if (e.key === "F12") {
        e.preventDefault();
      }
    },
    true,
  );

  // 4. Block text selection via mouse
  document.addEventListener(
    "selectstart",
    (e) => {
      if (!isFormTarget(e)) e.preventDefault();
    },
    true,
  );

  // 5. Block drag (image/link drag leaks content)
  document.addEventListener(
    "dragstart",
    (e) => {
      if (!isFormTarget(e)) e.preventDefault();
    },
    true,
  );

  // 6. Disable print (Ctrl+P / Cmd+P)
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
      }
    },
    true,
  );
}
