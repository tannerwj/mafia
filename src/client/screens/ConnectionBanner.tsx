import type { ConnectionStatus } from "../net/RoomConnection";

export default function ConnectionBanner({
  status,
}: {
  status: ConnectionStatus;
}) {
  if (status === "open" || status === "closed") return null;

  const label =
    status === "connecting" ? "Connecting…" : "Reconnecting…";

  return (
    <div
      data-testid="connection-banner"
      data-status={status}
      className="w-full bg-amber-800 px-4 py-2 text-center text-sm text-stone-50"
    >
      {label}
    </div>
  );
}
