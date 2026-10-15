import { describe, expect, it } from "vitest";
import { parseUserVaults } from "../src/config";

describe("parseUserVaults", () => {
  it("maps each Slack user to their vault IDs", () => {
    const m = parseUserVaults("U1=vlt_a; U2 = vlt_b, vlt_c");
    expect(m.get("U1")).toEqual(["vlt_a"]);
    expect(m.get("U2")).toEqual(["vlt_b", "vlt_c"]);
  });

  it("is empty when unset", () => {
    expect(parseUserVaults(undefined).size).toBe(0);
  });
});
