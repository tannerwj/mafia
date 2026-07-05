import { Toaster } from "sonner";
import GrainOverlay from "./components/ui/GrainOverlay";
import Home from "./screens/Home";
import Room from "./screens/Room";
import { useRoute } from "./useRoute";

export default function App() {
  const route = useRoute();

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
            background: "#1c1a15",
            color: "#d8c69a",
            border: "1px solid #3d382c",
            fontFamily:
              'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
          },
        }}
      />
    </>
  );
}
