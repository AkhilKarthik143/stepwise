import { describe, expect, it } from "vitest";
import { toHistory, type ChatTurn } from "./chatApi";

describe("toHistory", () => {
  it("keeps role + text, drops images and empties", () => {
    const turns: ChatTurn[] = [
      { role: "user", text: "hi", image: "data:..." },
      { role: "assistant", text: "hello" },
      { role: "user", text: "   " }, // blank -> dropped
    ];
    expect(toHistory(turns)).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  it("drops error turns", () => {
    const turns: ChatTurn[] = [
      { role: "assistant", text: "boom", error: true },
      { role: "user", text: "ok" },
    ];
    expect(toHistory(turns)).toEqual([{ role: "user", text: "ok" }]);
  });

  it("caps to the last `max` turns", () => {
    const turns: ChatTurn[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as ChatTurn["role"],
      text: `m${i}`,
    }));
    const out = toHistory(turns, 4);
    expect(out).toHaveLength(4);
    expect(out[0].text).toBe("m16");
    expect(out[3].text).toBe("m19");
  });
});
