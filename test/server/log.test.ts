import { describe, expect, test, vi } from "vitest";
import { logEvent } from "../../src/server/log";
import { assertLogHygiene, tallyRoleCounts } from "../../src/server/log-events";
import { writeMetric } from "../../src/server/metrics";

describe("logEvent", () => {
  test("emits one JSON line with `evt` first", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("room_claimed", { roomCode: "ABCDE" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe("evt");
    expect(parsed.evt).toBe("room_claimed");
    expect(parsed.roomCode).toBe("ABCDE");
    spy.mockRestore();
  });

  test("never throws on a circular field", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logEvent("test_event", { circular })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("never throws on a BigInt field", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => logEvent("test_event", { big: 10n as unknown as number })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("defaults fields to {} when omitted", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("ping_test");
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(parsed).toEqual({ evt: "ping_test" });
    spy.mockRestore();
  });
});

describe("tallyRoleCounts", () => {
  test("aggregates roleId counts, never keyed by player", () => {
    const players = [
      { roleId: "mafia" },
      { roleId: "villager" },
      { roleId: "villager" },
      { roleId: "detective" },
    ];
    expect(tallyRoleCounts(players)).toEqual({ mafia: 1, villager: 2, detective: 1 });
  });

  test("empty roster yields empty counts", () => {
    expect(tallyRoleCounts([])).toEqual({});
  });
});

describe("assertLogHygiene — THE LOG HYGIENE HARD RULE", () => {
  test("passes a clean game_started-shaped payload", () => {
    expect(() =>
      assertLogHygiene({
        roomCode: "ABCDE",
        playerCount: 6,
        roleCounts: { mafia: 2, villager: 3, detective: 1 },
      }),
    ).not.toThrow();
  });

  test("passes a clean story_generate-shaped payload", () => {
    expect(() =>
      assertLogHygiene({
        roomCode: "ABCDE",
        beat: "morning-report",
        outcome: "ok",
        latencyMs: 1234,
        model: "@cf/meta/llama-4-scout-17b-16e-instruct",
      }),
    ).not.toThrow();
  });

  test("passes a clean room_wiped-shaped payload", () => {
    expect(() => assertLogHygiene({ roomCode: "ABCDE", reason: "ended_ttl", idleMs: 7_200_000 })).not.toThrow();
  });

  test("rejects a payload with player names", () => {
    expect(() => assertLogHygiene({ roomCode: "ABCDE", name: "Hank" })).toThrow(/forbidden key "name"/);
  });

  test("rejects a payload with a seat token", () => {
    expect(() => assertLogHygiene({ roomCode: "ABCDE", seatToken: "secret-uuid" })).toThrow(/forbidden key "seatToken"/);
  });

  test("rejects a payload with a host key", () => {
    expect(() => assertLogHygiene({ hostKey: "secret-uuid" })).toThrow(/forbidden key "hostKey"/);
  });

  test("rejects a payload with vote/target contents", () => {
    expect(() => assertLogHygiene({ target: "player-123" })).toThrow(/forbidden key "target"/);
    expect(() => assertLogHygiene({ votes: [{ playerId: "a", target: "b" }] })).toThrow(/forbidden key "votes"/);
  });

  test("rejects a payload with story text or theme", () => {
    expect(() => assertLogHygiene({ scene: "The rain fell..." })).toThrow(/forbidden key "scene"/);
    expect(() => assertLogHygiene({ theme: "noir detective" })).toThrow(/forbidden key "theme"/);
  });

  test("catches a forbidden key nested inside an array of objects", () => {
    expect(() =>
      assertLogHygiene({
        roomCode: "ABCDE",
        roleAssignments: [{ playerId: "p1", name: "Hank" }],
      }),
    ).toThrow(/forbidden key "name"/);
  });

  test("catches a forbidden key nested inside a plain sub-object", () => {
    expect(() => assertLogHygiene({ auth: { hostKey: "secret" } })).toThrow(/forbidden key "hostKey"/);
  });

  test("does not flag benign keys that merely contain a substring of a forbidden word", () => {
    // roomCode, playerCount, latencyMs etc. must never false-positive.
    expect(() => assertLogHygiene({ roomCode: "ABCDE", playerCount: 5, latencyMs: 10, model: "x" })).not.toThrow();
  });
});

describe("writeMetric — METRICS binding absence is a silent no-op", () => {
  test("does nothing and never throws when env.METRICS is absent", () => {
    expect(() => writeMetric({}, { doubles: [1] })).not.toThrow();
  });

  test("never throws even if the bound writeDataPoint itself throws", () => {
    const env = {
      METRICS: {
        writeDataPoint: () => {
          throw new Error("AE is down");
        },
      },
    } as unknown as { METRICS: AnalyticsEngineDataset };
    expect(() => writeMetric(env, { doubles: [1] })).not.toThrow();
  });

  test("calls writeDataPoint with only the provided fields (omits unset keys rather than passing undefined)", () => {
    const calls: unknown[] = [];
    const env = {
      METRICS: { writeDataPoint: (point: unknown) => calls.push(point) },
    } as unknown as { METRICS: AnalyticsEngineDataset };

    writeMetric(env, { doubles: [42] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ doubles: [42] });
  });
});
