import { useEffect, useState } from "react";

// Hand-rolled router — zero new deps (spec 01 dependency budget). Only two
// routes exist in this spec: home ("/") and "/room/:code".
export type Route = { name: "home" } | { name: "room"; code: string };

function parseRoute(pathname: string): Route {
  const match = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      const code = decodeURIComponent(match[1]!).toUpperCase();
      // Keep the SPA's not-found screen reachable for any five-character
      // alphanumeric code. The Worker API applies the stricter generated-code
      // alphabet before it performs a Durable Object lookup.
      if (/^[A-Z0-9]{5}$/.test(code)) return { name: "room", code };
    } catch {
      // Treat malformed URL escapes as an ordinary home route rather than
      // allowing a browser supplied pathname to crash the app.
    }
  }
  return { name: "home" };
}

export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname),
  );

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return route;
}
