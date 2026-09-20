/** Progressive enhancement: the server-rendered artwork is always the fallback. */
export interface MotionBundle {
  animations: Animation[];
  onFrame?: () => void;
  reset?: () => void;
}

type Entry = {
  root: HTMLElement;
  factory: () => MotionBundle;
  bundle?: MotionBundle;
  visible: boolean;
  failed: boolean;
  hovered: boolean;
  rate: number;
  detach: () => void;
};

const entries = new Set<Entry>();
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
const supported = typeof Element.prototype.animate === "function"
  && typeof IntersectionObserver === "function";
let pageActive = true;
let frame = 0;
let previousTime = 0;

const active = (entry: Entry) => supported && !reduced.matches && pageActive
  && document.visibilityState !== "hidden" && entry.visible && !entry.failed;
const finished = (entry: Entry) => Boolean(entry.bundle?.animations.length)
  && entry.bundle!.animations.every((animation) => animation.playState === "finished");

function restore(entry: Entry) {
  entry.bundle?.animations.forEach((animation) => animation.cancel());
  entry.bundle?.reset?.();
  entry.bundle = undefined;
  entry.rate = 1;
}

function schedule() {
  if (!frame && [...entries].some((entry) => active(entry) && entry.bundle && !finished(entry)
    && (entry.bundle.onFrame || Math.abs(entry.rate - (entry.hovered ? 1.3 : 1)) > 0.001))) {
    frame = requestAnimationFrame(tick);
  }
}

function sync(entry: Entry) {
  if (reduced.matches || !supported || entry.failed) {
    restore(entry);
    entry.root.dataset.motionState = entry.failed ? "failed" : "static";
    return;
  }
  if (active(entry) && !entry.bundle) {
    const before = new Set(entry.root.getAnimations({ subtree: true }));
    try {
      entry.bundle = entry.factory();
      entry.rate = 1;
      entry.bundle.animations.forEach((animation) => {
        animation.pause();
        animation.currentTime = 0;
        animation.playbackRate = 1;
      });
    } catch {
      // Also cancel partial factory output so a failed enhancement stays static.
      entry.root.getAnimations({ subtree: true }).forEach((animation) => {
        if (!before.has(animation)) animation.cancel();
      });
      entry.failed = true;
      restore(entry);
      entry.root.dataset.motionState = "failed";
      return;
    }
  }
  const bundle = entry.bundle;
  if (!bundle) {
    entry.root.dataset.motionState = "paused";
    return;
  }
  bundle.onFrame?.();
  const done = finished(entry);
  bundle.animations.forEach((animation) => {
    if (animation.playState === "finished") return;
    if (active(entry)) {
      if (animation.playState !== "running") animation.play();
    } else if (animation.playState !== "paused") animation.pause();
  });
  entry.root.dataset.motionState = done ? "finished" : active(entry) ? "running" : "paused";
  schedule();
}

function tick(time: number) {
  frame = 0;
  // A media-query value can change before its change event is delivered.
  // Restore immediately rather than dropping the last frame and leaving the
  // native tracks running with a frozen intermediate counter.
  if (reduced.matches) {
    syncAll();
    return;
  }
  const elapsed = previousTime ? Math.min(time - previousTime, 50) : 16;
  previousTime = time;
  entries.forEach((entry) => {
    if (!active(entry) || !entry.bundle) return;
    const target = entry.hovered ? 1.3 : 1;
    const nextRate = entry.rate + (target - entry.rate) * (1 - Math.exp(-elapsed / 100));
    const rate = Math.abs(nextRate - target) < 0.001 ? target : nextRate;
    if (rate !== entry.rate && !finished(entry)) {
      entry.rate = rate;
      entry.bundle.animations.forEach((animation) => {
        if (typeof animation.updatePlaybackRate === "function") animation.updatePlaybackRate(rate);
        else animation.playbackRate = rate;
      });
    }
    entry.bundle.onFrame?.();
    if (finished(entry)) entry.root.dataset.motionState = "finished";
  });
  schedule();
  if (!frame) previousTime = 0;
}

const observer = supported ? new IntersectionObserver((changes) => {
  changes.forEach((change) => {
    const entry = [...entries].find((item) => item.root === change.target);
    if (!entry) return;
    entry.visible = change.isIntersecting && change.intersectionRatio >= 0.12;
    sync(entry);
  });
}, { threshold: [0, 0.12] }) : undefined;

export function registerMotion(root: HTMLElement, factory: () => MotionBundle): () => void {
  // A module can be reevaluated by HMR; never leave two owners on one illustration.
  [...entries].filter((entry) => entry.root === root).forEach(remove);
  const hoverTarget = root.closest<HTMLElement>(".feature-card") ?? root;
  const entry: Entry = { root, factory, visible: false, failed: false, hovered: false, rate: 1, detach: () => {} };
  const enter = (event: PointerEvent) => {
    if (!finePointer.matches || event.pointerType === "touch") return;
    entry.hovered = true;
    schedule();
  };
  const leave = () => { entry.hovered = false; schedule(); };
  hoverTarget.addEventListener("pointerenter", enter);
  hoverTarget.addEventListener("pointerleave", leave);
  entry.detach = () => {
    hoverTarget.removeEventListener("pointerenter", enter);
    hoverTarget.removeEventListener("pointerleave", leave);
  };
  entries.add(entry);
  observer?.observe(root);
  sync(entry);
  return () => remove(entry);
}

function remove(entry: Entry) {
  observer?.unobserve(entry.root);
  entry.detach();
  restore(entry);
  entries.delete(entry);
}

function syncAll() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  previousTime = 0;
  entries.forEach((entry) => {
    if (!entry.root.isConnected) remove(entry);
    else {
      if (!finePointer.matches) entry.hovered = false;
      sync(entry);
    }
  });
}

const onHide = () => { pageActive = false; syncAll(); };
const onShow = () => { pageActive = true; syncAll(); };
document.addEventListener("visibilitychange", syncAll);
reduced.addEventListener("change", syncAll);
finePointer.addEventListener("change", syncAll);
window.addEventListener("pagehide", onHide);
window.addEventListener("pageshow", onShow);

if (import.meta.hot) import.meta.hot.dispose(() => {
  entries.forEach(remove);
  observer?.disconnect();
  cancelAnimationFrame(frame);
  document.removeEventListener("visibilitychange", syncAll);
  reduced.removeEventListener("change", syncAll);
  finePointer.removeEventListener("change", syncAll);
  window.removeEventListener("pagehide", onHide);
  window.removeEventListener("pageshow", onShow);
});
