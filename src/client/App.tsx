import Home from "./screens/Home";
import Room from "./screens/Room";
import { useRoute } from "./useRoute";

export default function App() {
  const route = useRoute();

  if (route.name === "room") {
    return <Room key={route.code} code={route.code} />;
  }

  return <Home />;
}
