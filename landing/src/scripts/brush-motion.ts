import { registerMotion, type MotionBundle } from "./motion-runtime";

const SWEEP_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";
const REST_POSE = "translateX(0px) rotate(0deg)";

function createBrushMotion(root: HTMLElement): MotionBundle {
  const shape = root.querySelector<SVGGElement>("[data-brush-shape]");
  if (!shape) return { animations: [] };

  // The source's translucent path contains both handle and bristles, so both
  // original paths travel together. The outer responsive placement stays intact.
  const sweep = shape.animate(
    [
      { offset: 0, transform: REST_POSE, easing: SWEEP_EASING },
      { offset: 0.1, transform: REST_POSE, easing: SWEEP_EASING },
      { offset: 0.2, transform: "translateX(-6px) rotate(-3deg)", easing: SWEEP_EASING },
      { offset: 0.31, transform: "translateX(6px) rotate(3deg)", easing: SWEEP_EASING },
      { offset: 0.42, transform: "translateX(-6px) rotate(-3deg)", easing: SWEEP_EASING },
      { offset: 0.53, transform: "translateX(6px) rotate(3deg)", easing: SWEEP_EASING },
      { offset: 0.63, transform: REST_POSE, easing: SWEEP_EASING },
      { offset: 1, transform: REST_POSE },
    ],
    { duration: 7600, iterations: Infinity, easing: "linear" },
  );

  // Visibility, reduced motion and phase-preserving hover speed belong to the
  // shared runtime. With no script, the server-rendered source SVG remains still.
  sweep.pause();
  return { animations: [sweep] };
}

const cleanups = [...document.querySelectorAll<HTMLElement>('[data-motion="brush"]')]
  .map((root) => registerMotion(root, () => createBrushMotion(root)));

if (import.meta.hot) import.meta.hot.dispose(() => cleanups.forEach((cleanup) => cleanup()));
