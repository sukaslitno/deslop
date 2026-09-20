import { registerMotion, type MotionBundle } from "./motion-runtime";

const DURATION = 8400;
const EASING = "cubic-bezier(0.45, 0, 0.55, 1)";

function createAlarmMotion(root: HTMLElement): MotionBundle {
  const shape = root.querySelector<SVGGElement>("[data-alarm-shape]");
  const left = root.querySelector<SVGGElement>('[data-alarm-bell="left"]');
  const right = root.querySelector<SVGGElement>('[data-alarm-bell="right"]');
  if (!shape || !left || !right) return { animations: [] };

  const animate = (element: SVGGElement, frames: Keyframe[]) => {
    const animation = element.animate(frames, {
      duration: DURATION,
      iterations: Infinity,
      easing: "linear",
    });
    animation.pause();
    return animation;
  };

  // Two slow rings, with a pause between them and a long quiet loop seam.
  // Each bell rotates about its own source bounds in the opposite direction.
  const bellFrames = (direction: number): Keyframe[] => [
    { offset: 0, transform: "rotate(0deg)", easing: EASING },
    { offset: 0.12, transform: "rotate(0deg)", easing: EASING },
    { offset: 0.2, transform: `rotate(${4 * direction}deg)`, easing: EASING },
    { offset: 0.28, transform: `rotate(${-4 * direction}deg)`, easing: EASING },
    { offset: 0.36, transform: "rotate(0deg)", easing: EASING },
    { offset: 0.46, transform: "rotate(0deg)", easing: EASING },
    { offset: 0.54, transform: `rotate(${-4 * direction}deg)`, easing: EASING },
    { offset: 0.62, transform: `rotate(${4 * direction}deg)`, easing: EASING },
    { offset: 0.7, transform: "rotate(0deg)", easing: EASING },
    { offset: 1, transform: "rotate(0deg)" },
  ];

  // Move the whole SVG group so the body and play mark always stay connected.
  // Never animate the outer wrapper: it owns responsive centering and scaling.
  const hop = animate(shape, [
    { offset: 0, transform: "translateY(0px)", easing: EASING },
    { offset: 0.12, transform: "translateY(0px)", easing: EASING },
    { offset: 0.24, transform: "translateY(-3px)", easing: EASING },
    { offset: 0.4, transform: "translateY(0px)", easing: EASING },
    { offset: 0.46, transform: "translateY(0px)", easing: EASING },
    { offset: 0.58, transform: "translateY(-2px)", easing: EASING },
    { offset: 0.74, transform: "translateY(0px)", easing: EASING },
    { offset: 1, transform: "translateY(0px)" },
  ]);

  return { animations: [hop, animate(left, bellFrames(1)), animate(right, bellFrames(-1))] };
}

const cleanups = [...document.querySelectorAll<HTMLElement>('[data-motion="alarm"]')]
  .map((root) => registerMotion(root, () => createAlarmMotion(root)));

if (import.meta.hot) import.meta.hot.dispose(() => cleanups.forEach((cleanup) => cleanup()));
