import { registerMotion, type MotionBundle } from "./motion-runtime";

const DELAY = 500;
const COUNTER_DURATION = 2800;
const BAR_DURATION = 6000;

function createDiskMotion(root: HTMLElement): MotionBundle {
  const values = [...root.querySelectorAll<HTMLElement>("[data-disk-value]")];
  const bars = [...root.querySelectorAll<HTMLElement>("[data-disk-bar]")];
  const used = values.find((element) => element.dataset.diskValue === "used");
  if (!used || bars.length !== 4) throw new Error("Incomplete disk illustration");

  const counters = values.map((element) => {
    // HMR or a repeated enhancement can encounter an already-counting DOM.
    // Always restore the server-rendered value, never an intermediate frame.
    const original = element.closest<HTMLElement>("[data-disk-original]")?.dataset.diskOriginal
      ?? element.textContent ?? "";
    const match = original.match(/^([\d.,]+)\s*(GB|MB)$/);
    if (!match) throw new Error("Invalid demonstration size");
    return { element, original, start: Number(match[1].replace(",", ".")), unit: match[2] };
  });
  const cleanedGB = counters.reduce((sum, counter) => counter.element === used
    ? sum : sum + counter.start / (counter.unit === "MB" ? 1000 : 1), 0);
  const formatter = new Intl.NumberFormat(root.dataset.diskLocale === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });

  const animations = bars.map((bar) => {
    const animation = bar.animate([
      { width: "var(--disk-segment-width)", marginInlineStart: "var(--vc-gap-2)" },
      { width: "0px", marginInlineStart: "0px" },
    ], { delay: DELAY, duration: BAR_DURATION, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" });
    animation.pause();
    return animation;
  });

  // The first bar's native timeline is the only clock: pause and hover speed
  // stay aligned without a second observer or animation-frame loop.
  const clock = animations[0];
  let previousTime = -Infinity;
  let countersFinished = false;

  return {
    animations,
    onFrame() {
      if (countersFinished) return;
      const time = typeof clock.currentTime === "number" ? clock.currentTime : 0;
      const progress = Math.max(0, Math.min(1, (time - DELAY) / COUNTER_DURATION));
      if (progress < 1 && time - previousTime < 1000 / 30) return;
      previousTime = time;
      const eased = 1 - (1 - progress) ** 3;
      counters.forEach((counter) => {
        const end = counter.element === used ? Math.max(0, counter.start - cleanedGB) : 0;
        const value = counter.start + (end - counter.start) * eased;
        const text = `${formatter.format(value)} ${counter.unit}`;
        if (counter.element.textContent !== text) counter.element.textContent = text;
      });
      countersFinished = progress === 1;
    },
    reset() {
      counters.forEach(({ element, original }) => { element.textContent = original; });
    },
  };
}

const remove = [...document.querySelectorAll<HTMLElement>('[data-motion="disk"]')]
  .map((root) => registerMotion(root, () => createDiskMotion(root)));

if (import.meta.hot) import.meta.hot.dispose(() => remove.forEach((dispose) => dispose()));
