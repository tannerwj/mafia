// The single global grain/texture layer (Spec 09 D1). Mounted ONCE at app
// root, behind all content. Purely decorative: the `.grain-overlay` class in
// index.css pins `position: fixed`, `pointer-events: none`, `z-index: 0`, and
// a very low opacity inline-SVG-noise `background-image` (a `data:` URI, never
// a hosted asset) — so it can never intercept a tap and never issues an
// external request. `aria-hidden` keeps it out of the accessibility tree.
export default function GrainOverlay() {
  return <div className="grain-overlay" aria-hidden="true" />;
}
