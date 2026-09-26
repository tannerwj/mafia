import { useLayoutEffect, useRef } from "react";
import { Toaster } from "sonner";
import GrainOverlay from "./components/ui/GrainOverlay";
import Home from "./screens/Home";
import Room from "./screens/Room";
import { useGameStore } from "./store/gameStore";
import { useRoute, type Route } from "./useRoute";

export default function App() {
  const route = useRoute();
  const room = useGameStore((state) => state.room);
  const previousRoute = useRef<Route | null>(null);

  // The skin is a public room property. Resolve it from the latest
  // authoritative snapshot at document root so Radix portals, toasts, and
  // the decorative grain layer inherit the same table look. A home page or a
  // pre-snapshot room always starts from Atelier and cannot retain a previous
  // room's visual identity.
  useLayoutEffect(() => {
    // `Room` disconnects in a passive effect and the store intentionally keeps
    // its last authoritative snapshot for reconnect recovery. A same-room
    // SPA re-entry can therefore render with the old snapshot while auth is
    // still resolving. Treat every route object change as pre-welcome until a
    // new snapshot changes `room`; this also covers home -> room transitions.
    const routeChanged = previousRoute.current !== route;
    previousRoute.current = route;
    const candidate = !routeChanged && route.name === "room" && room?.roomCode === route.code
      ? room.visualTheme
      : undefined;
    const visualTheme = candidate === "club" || candidate === "rain" ? candidate : "atelier";
    document.documentElement.dataset.visualTheme = visualTheme;
  }, [room, route]);

  return (
    <>
      {/* Single global grain layer, mounted once behind all content.
          `pointer-events: none` (in index.css) — can never eat a tap. */}
      <GrainOverlay />
      {route.name === "room" ? <Room key={route.code} code={route.code} /> : <Home />}
      <Toaster
        theme="dark"
        position="top-center"
        toastOptions={{
          style: {
            background: "var(--color-ink-3)",
            color: "var(--color-paper)",
            border: "1px solid var(--color-frame)",
            fontFamily:
              "var(--font-sans)",
          },
        }}
      />
    </>
  );
}
