// Client-side credential storage. Holds credentials ONLY — no game/room
// state is ever persisted client-side.
//
// sessionStorage is canonical (per-tab, so multiple tabs of one browser are
// distinct players by design). localStorage is a device backup: an array,
// because a shared party phone may hold several people's seats.

export interface SeatBackupEntry {
  seatToken: string;
  name: string;
  savedAt: number;
}

function seatKey(code: string): string {
  return `mafia:${code}:seat`;
}

function seatsBackupKey(code: string): string {
  return `mafia:${code}:seats`;
}

function hostKeyKey(code: string): string {
  return `mafia:${code}:hostKey`;
}

function hostKeyBackupKey(code: string): string {
  return `mafia:${code}:hostKey:backup`;
}

export function getSessionSeat(code: string): string | null {
  return sessionStorage.getItem(seatKey(code));
}

export function setSessionSeat(code: string, seatToken: string): void {
  sessionStorage.setItem(seatKey(code), seatToken);
}

export function clearSessionSeat(code: string): void {
  sessionStorage.removeItem(seatKey(code));
}

export function getSeatBackups(code: string): SeatBackupEntry[] {
  const raw = localStorage.getItem(seatsBackupKey(code));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SeatBackupEntry[]) : [];
  } catch {
    return [];
  }
}

/** Appends a new backup entry — never overwrites others sharing this device. */
export function appendSeatBackup(
  code: string,
  entry: SeatBackupEntry,
): void {
  const backups = getSeatBackups(code);
  backups.push(entry);
  localStorage.setItem(seatsBackupKey(code), JSON.stringify(backups));
}

/** A 4003 on a backup token removes only that entry. */
export function removeSeatBackup(code: string, seatToken: string): void {
  const backups = getSeatBackups(code).filter(
    (b) => b.seatToken !== seatToken,
  );
  localStorage.setItem(seatsBackupKey(code), JSON.stringify(backups));
}

export function getSessionHostKey(code: string): string | null {
  return sessionStorage.getItem(hostKeyKey(code));
}

export function setSessionHostKey(code: string, hostKey: string): void {
  sessionStorage.setItem(hostKeyKey(code), hostKey);
  localStorage.setItem(hostKeyBackupKey(code), hostKey);
}

export function getHostKeyBackup(code: string): string | null {
  return localStorage.getItem(hostKeyBackupKey(code));
}

export function clearHostKeyBackup(code: string): void {
  localStorage.removeItem(hostKeyBackupKey(code));
}
