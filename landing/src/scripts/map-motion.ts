import { registerMotion, type MotionBundle } from "./motion-runtime";

const LAYER_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";

function layerFrames(direction: number): Keyframe[] {
  const position = (distance: number) => `translateY(${distance * direction}px)`;
  return [
    { offset: 0, transform: position(0), easing: LAYER_EASING },
    { offset: 0.08, transform: position(0), easing: LAYER_EASING },
    { offset: 0.32, transform: position(7), easing: LAYER_EASING },
    { offset: 0.4, transform: position(7), easing: LAYER_EASING },
    { offset: 0.72, transform: position(-7), easing: LAYER_EASING },
    { offset: 0.8, transform: position(-7), easing: LAYER_EASING },
    { offset: 1, transform: position(0) },
  ];
}

function createMapMotion(root: HTMLElement): MotionBundle {
  const top = root.querySelector<SVGGElement>('[data-map-layer="top"]');
  const bottom = root.querySelector<SVGGElement>('[data-map-layer="bottom"]');
  if (!top || !bottom) return { animations: [] };

  // Only the inner groups move. SVG layer placement and the responsive outer
  // wrapper retain their original transforms; the middle stays at its anchor.
  const animations = ([
    [top, -1],
    [bottom, 1],
  ] as const).map(([layer, direction]) => {
    const animation = layer.animate(layerFrames(direction), {
      duration: 9200,
      iterations: Infinity,
      easing: "linear",
    });
    animation.pause();
    return animation;
  });

  return { animations };
}

const cleanups = [...document.querySelectorAll<HTMLElement>('[data-motion="map"]')]
  .map((root) => registerMotion(root, () => createMapMotion(root)));

if (import.meta.hot) import.meta.hot.dispose(() => cleanups.forEach((cleanup) => cleanup()));
