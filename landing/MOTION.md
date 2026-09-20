# Landing motion

The visual reference is the user's four supplied screenshots and the existing
Figma-exported artwork. Keep the same composition, typography, semantic colors,
corner tokens and responsive placement. Only the illustrative content moves.
Refero's reference-lock method and Emil's motion guidance inform the implementation:
smooth acceleration/deceleration, long rests, native animations and static fallback.

| Illustration | Movement | Timing |
| --- | --- | --- |
| Disk | Used space counts from 60.1 to 56.2 GB; four caches count to zero. Rounded colored segments and their gaps shrink to zero. | 0.5 s entry pause; numbers 2.8 s; bars 6 s. Plays once, holds the result. |
| Brush | Two connected sweeps, ±6 px and ±3°. No separation of handle and body. | 7.6 s loop; 47% resting. |
| Map | Full closed layers expand/compress, top/bottom ±7 px, middle stationary. | 9.2 s loop with end rests. |
| Alarm | Opposing ±4° bell rotations, whole illustration lifts no more than 3 px. | 8.4 s loop, two quiet rings with rests. |

The shared runtime starts an illustration when at least 12% enters the viewport.
It pauses outside the viewport, in hidden tabs and on pagehide, then resumes the
same phase. Fine-pointer hover smoothly approaches 1.3× playback speed and returns
to 1× on leave; touch does not latch hover. Looping SVG tracks use transforms only.
The four disk widths are the deliberate exception: native width interpolation
preserves round ends, and layout/paint is contained inside the small track.

Server-rendered SVG and disk markup are complete before JavaScript runs. Missing
scripts, missing animation/observer support and reduced-motion preferences leave
static illustrations. Changing the motion preference restores the original values
and artwork. All assets required for the three illustrations are inline; there
are no animation libraries, remote animation files or media requests.

`tests/motion.spec.ts` covers live counting and resizing, phase-preserving hover,
offscreen pause/resume, reduced-motion changes, missing capabilities/scripts and
touch layout. The existing reference/content suite uses reduced motion so its
geometry assertions remain deterministic. Run Chromium and WebKit with different
`--output` paths if testing them concurrently.

The current preview is the shared Astro dev server from `landing/` on port 4321.
This change belongs to the website; it does not require a Tauri backend rebuild.
