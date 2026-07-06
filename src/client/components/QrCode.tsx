// Spec 16 D4: renders a QR code (src/client/lib/qr.ts) to a <canvas>, dark
// modules on a light tile — deliberately NOT inverted to the noir ink/paper
// palette, since contrast is what makes it camera-scannable across a table.
// A quiet zone (4 modules, the ISO/IEC 18004 minimum) is included on all
// sides so phone cameras can lock on even close to the tile's edge.
import { useEffect, useRef } from "react";
import { encodeQr } from "../lib/qr";

const QUIET_ZONE_MODULES = 4;

export default function QrCode({
  value,
  size = 220,
  className,
}: {
  /** The full text to encode (a complete URL for this spec). */
  value: string;
  /** Rendered pixel size (square). */
  size?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { size: moduleCount, modules } = encodeQr(value);
    const dpr = window.devicePixelRatio || 1;
    const totalModules = moduleCount + QUIET_ZONE_MODULES * 2;
    const pixelSize = Math.max(1, Math.floor((size * dpr) / totalModules));
    const canvasPx = pixelSize * totalModules;

    canvas.width = canvasPx;
    canvas.height = canvasPx;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    ctx.fillStyle = "#f5f0e6"; // paper-light tile — always light, regardless of theme
    ctx.fillRect(0, 0, canvasPx, canvasPx);
    ctx.fillStyle = "#161311"; // ink-dark modules
    for (let y = 0; y < moduleCount; y++) {
      for (let x = 0; x < moduleCount; x++) {
        if (!modules[y]![x]) continue;
        const px = (x + QUIET_ZONE_MODULES) * pixelSize;
        const py = (y + QUIET_ZONE_MODULES) * pixelSize;
        ctx.fillRect(px, py, pixelSize, pixelSize);
      }
    }
  }, [value, size]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="room-qr"
      data-qr-value={value}
      role="img"
      aria-label="QR code to join this game"
      title={value}
      className={className}
    />
  );
}
