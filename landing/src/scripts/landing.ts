const dialog = document.querySelector<HTMLDialogElement>("[data-download-dialog]");
const main = document.querySelector<HTMLElement>("#main-content");
const triggers = document.querySelectorAll<HTMLAnchorElement>("[data-download-trigger]");
const closeButton = dialog?.querySelector<HTMLButtonElement>("[data-download-close]");
const dialogTitle = dialog?.querySelector<HTMLElement>("#download-dialog-title");
const architectureChoices = dialog ? Array.from(dialog.querySelectorAll<HTMLDetailsElement>(".architecture-choice")) : [];
const focusStart = dialog?.querySelector<HTMLElement>("[data-focus-start]");
const focusEnd = dialog?.querySelector<HTMLElement>("[data-focus-end]");
const mobileQuery = window.matchMedia("(max-width: 767px)");
const mobileContinue = dialog?.querySelector<HTMLButtonElement>("[data-mobile-continue]");
const choices = dialog?.querySelector<HTMLElement>("[data-download-choices]");
const notices = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>("[data-download-notice]")) : [];
const titleVariants = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>("[data-dialog-title]")) : [];

let dialogOpener: HTMLElement | null = null;
let dialogScrollPosition = 0;
let backdropPointerDown = false;
let priorBodyStyle: { position: string; top: string; width: string; overflow: string } | null = null;
let dialogOrigin: "mobile" | "desktop" | null = null;
let mobileStep: "intro" | "platforms" = "intro";
let platformPointerGuardUntil = 0;

function syncDialogContent(): void {
  if (!dialog) return;
  const intro = dialogOrigin === "mobile" && mobileStep === "intro";
  const title = intro ? "mobile-intro" : dialogOrigin === "mobile" ? "mobile-platforms" : "desktop";
  titleVariants.forEach((variant) => { variant.hidden = variant.dataset.dialogTitle !== title; });
  if (mobileContinue) mobileContinue.hidden = !intro;
  if (choices) choices.hidden = intro;
  notices.forEach((notice) => { notice.hidden = intro; });
  dialog.classList.toggle("is-mobile-presentation", mobileQuery.matches);
  dialog.classList.toggle("is-mobile-intro", intro);
}

function dialogFocusableElements(): HTMLElement[] {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), summary"))
    .filter((element) => {
      const parentChoice = element.closest<HTMLDetailsElement>(".architecture-choice");
      return !element.hasAttribute("hidden") && element.getClientRects().length > 0 && !(parentChoice && !parentChoice.open && element.tagName !== "SUMMARY");
    });
}

function restorePage(): void {
  if (!dialog) return;
  main?.removeAttribute("inert");
  document.documentElement.style.removeProperty("scrollbar-gutter");
  if (priorBodyStyle) {
    document.body.style.position = priorBodyStyle.position;
    document.body.style.top = priorBodyStyle.top;
    document.body.style.width = priorBodyStyle.width;
    document.body.style.overflow = priorBodyStyle.overflow;
    priorBodyStyle = null;
  }
  architectureChoices.forEach((choice) => { choice.open = false; });
  dialogOrigin = null;
  mobileStep = "intro";
  platformPointerGuardUntil = 0;
  syncDialogContent();
  window.scrollTo(0, dialogScrollPosition);
  dialogOpener?.focus({ preventScroll: true });
  dialogOpener = null;
}

function openDialog(trigger: HTMLElement): void {
  if (!dialog || dialog.open) return;
  dialogOpener = trigger;
  dialogScrollPosition = window.scrollY;
  dialogOrigin = mobileQuery.matches ? "mobile" : "desktop";
  mobileStep = dialogOrigin === "mobile" ? "intro" : "platforms";
  document.documentElement.style.scrollbarGutter = "stable";
  priorBodyStyle = { position: document.body.style.position, top: document.body.style.top, width: document.body.style.width, overflow: document.body.style.overflow };
  document.body.style.position = "fixed";
  document.body.style.top = `-${dialogScrollPosition}px`;
  document.body.style.width = "100%";
  document.body.style.overflow = "hidden";
  main?.setAttribute("inert", "");
  dialog.showModal();
  syncDialogContent();
  dialogTitle?.focus({ preventScroll: true });
}

for (const trigger of triggers) {
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    openDialog(trigger);
  });
}

closeButton?.addEventListener("click", () => dialog?.close());
mobileContinue?.addEventListener("click", () => {
  if (!dialog?.open || dialogOrigin !== "mobile" || mobileStep !== "intro") return;
  mobileStep = "platforms";
  platformPointerGuardUntil = performance.now() + 500;
  syncDialogContent();
  dialogTitle?.focus({ preventScroll: true });
});
choices?.addEventListener("pointerdown", (event) => {
  if (dialogOrigin === "mobile" && mobileStep === "platforms" && performance.now() < platformPointerGuardUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
choices?.addEventListener("click", (event) => {
  if (dialogOrigin === "mobile" && mobileStep === "platforms" && performance.now() < platformPointerGuardUntil && event.detail > 0) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
dialog?.addEventListener("close", restorePage);
dialog?.addEventListener("cancel", () => {
  // Native dialog closes after cancel; restoration is deliberately centralized
  // in the close handler so Escape and the close icon have identical cleanup.
});
dialog?.addEventListener("pointerdown", (event) => { backdropPointerDown = event.target === dialog; });
dialog?.addEventListener("pointerup", (event) => {
  if (backdropPointerDown && event.target === dialog) dialog.close();
  backdropPointerDown = false;
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !dialog?.open) return;
  const focusable = dialogFocusableElements();
  if (!focusable.length) return;
  const active = document.activeElement as HTMLElement | null;
  const index = active ? focusable.indexOf(active) : -1;
  event.preventDefault();
  const next = index === -1 ? (event.shiftKey ? focusable.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
  focusable[next]?.focus();
}, true);
document.addEventListener("focusin", (event) => {
  if (!dialog?.open || (event.target instanceof Node && dialog.contains(event.target))) return;
  closeButton?.focus({ preventScroll: true });
});
focusStart?.addEventListener("focus", () => dialogFocusableElements().at(-1)?.focus({ preventScroll: true }));
focusEnd?.addEventListener("focus", () => dialogFocusableElements()[0]?.focus({ preventScroll: true }));
mobileQuery.addEventListener("change", () => {
  if (dialog?.open) syncDialogContent();
});
