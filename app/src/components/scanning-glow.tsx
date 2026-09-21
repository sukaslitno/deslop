import { useEffect, useState } from "react";
import scanGlowAqua from "@/assets/figma/scan-glow-aqua.svg?no-inline";
import scanGlowBlue from "@/assets/figma/scan-glow-blue.svg?no-inline";
import scanGlowWhite from "@/assets/figma/scan-glow-white.svg?no-inline";
import "./scanning-glow.css";

/** The three original Figma ellipses, moving independently along the bottom edge. */
export function ScanningGlow() {
  const [paused, setPaused] = useState(() => document.hidden);

  useEffect(() => {
    const syncVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  return (
    <div aria-hidden="true" className="scan-glow" data-paused={paused}>
      {/* Keep each asset's intrinsic geometry; the shared viewBox fits the window.
          A fixed-height, bottom-anchored canvas keeps light below the status copy. */}
      <svg className="scan-glow__canvas" viewBox="0 0 1040 700" preserveAspectRatio="none">
        <g className="scan-glow__layer scan-glow__layer--blue">
          <image href={scanGlowBlue} x="68.0485" y="468.0485" width="1144.03" height="464.629" />
        </g>
        <g className="scan-glow__layer scan-glow__layer--aqua">
          <g transform="translate(902.127 0) scale(-1 1)">
            <image href={scanGlowAqua} x="-105.1615" y="547.8385" width="1112.45" height="433.049" />
          </g>
        </g>
        <g className="scan-glow__layer scan-glow__layer--white">
          <image href={scanGlowWhite} x="319.524" y="619.524" width="802.147" height="386.073" />
        </g>
      </svg>
    </div>
  );
}
