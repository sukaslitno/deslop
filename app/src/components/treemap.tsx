import { useEffect, useMemo, useRef, useState } from "react";
import type { MapNode } from "@/lib/api";
import { human } from "@/lib/utils";
import { layoutTreemap, type TreemapRect } from "@/lib/treemap-layout";
import { Button, PathIsland } from "@/design-system";
import { toast } from "@/lib/toast";
import { useLocale } from "@/i18n";
import "./treemap.css";

// Matches Figma's 4px inset, 8px label and 4px gap below the label.
const CELL_INSET = 4;
const LABEL_HEIGHT = 8;
const CHILD_TOP = CELL_INSET + LABEL_HEIGHT + CELL_INSET;
const MAX_DEPTH = 4;

function Cell({ rect, depth, selectedId, onSelect }: {
  rect: TreemapRect<MapNode>;
  depth: number;
  selectedId: string | null;
  onSelect: (node: MapNode) => void;
}) {
  const { node } = rect;
  const canNest = depth < MAX_DEPTH && rect.w >= 56 && rect.h >= 40 && node.children.some((child) => child.size > 0);
  const children = canNest
    ? layoutTreemap(node.children, rect.w - CELL_INSET * 2, rect.h - CHILD_TOP - CELL_INSET, CELL_INSET)
    : [];
  return (
    <div className="vc-map-cell" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <button
        type="button"
        aria-label={`${node.name}, ${human(node.size)}, ${node.path}`}
        aria-pressed={selectedId === node.id}
        className="vc-map-tile vc-corner-smooth"
        data-depth={depth}
        onClick={(event) => { event.stopPropagation(); onSelect(node); }}
        title={`${node.name} · ${human(node.size)}\n${node.path}`}
      >
        {rect.w >= 24 && rect.h >= 16 && (
          <span className="vc-map-label text-style-micro">{node.name} · {human(node.size)}</span>
        )}
      </button>
      {children.length > 0 && (
        <div className="vc-map-children">
          {children.map((child) => (
            <Cell key={child.node.id} rect={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Treemap({ root, snapshotId, onReveal }: {
  root: MapNode;
  snapshotId: string;
  onReveal: (snapshotId: string, nodeId: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<MapNode | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelected(null); }, [root, snapshotId]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setDims({ w: element.clientWidth, h: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const rects = useMemo(() => layoutTreemap(
    root.children.some((child) => child.size > 0) ? root.children : [root], dims.w, dims.h, 2,
  ), [root, dims]);

  async function copyPath() {
    if (!selected || copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(selected.path);
      toast(t("mapPathCopied"));
    } catch {
      toast(t("mapCopyFailed"), "danger");
    } finally {
      setCopying(false);
    }
  }

  async function reveal() {
    if (!selected || revealing) return;
    setRevealing(true);
    try {
      await onReveal(snapshotId, selected.id);
    } catch {
      toast(t("mapRevealFailed"), "danger");
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="vc-map-results" onKeyDown={(event) => {
      if (event.key === "Escape") setSelected(null);
    }}>
      <section className="vc-map-surface vc-corner-smooth" aria-label={t("diskMap")} onClick={() => setSelected(null)}>
        <div ref={ref} className="vc-map-canvas">
          {rects.map((rect) => (
            <Cell key={rect.node.id} rect={rect} depth={0} selectedId={selected?.id ?? null} onSelect={setSelected} />
          ))}
          {dims.w > 0 && rects.length === 0 && <p className="vc-map-empty text-style-body-small">{t("mapNoData")}</p>}
        </div>
      </section>
      {selected && (
        <PathIsland
          className="vc-map-path"
          role="region"
          aria-label={t("selectedMapItem")}
          name={selected.name}
          size={human(selected.size)}
          path={selected.path}
        >
          <Button disabled={revealing || !selected.can_reveal} aria-busy={revealing} icon="folder" onClick={() => void reveal()} variant="gray">
            {t("mapFolder")}
          </Button>
          <Button disabled={copying} aria-busy={copying} icon="copy" onClick={() => void copyPath()} variant="gray">
            {t("copyPath")}
          </Button>
        </PathIsland>
      )}
    </div>
  );
}
