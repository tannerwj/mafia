import { Toaster } from "sonner";
import Home from "./screens/Home";
import Room from "./screens/Room";
import { useRoute } from "./useRoute";

export default function App() {
  const route = useRoute();

  return (
    <>
      {route.name === "room" ? <Room key={route.code} code={route.code} /> : <Home />}
      <Toaster
        theme="dark"
        position="top-center"
        toastOptions={{
          style: {
            background: "#1c1917",
            color: "#e7e5e4",
            border: "1px solid #44403c",
          },
        }}
      />
    </>
  );
}
