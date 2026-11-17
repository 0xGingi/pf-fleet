import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentMessage, SERVER_TYPES, ServerMessage } from "./index";

const dir = join(import.meta.dir, "../../../protocol/fixtures");
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("protocol fixtures (shared with the Rust agent)", () => {
  test("there are fixtures", () => expect(fixtures.length).toBeGreaterThan(5));

  for (const file of fixtures) {
    test(file, () => {
      const msg = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const schema = (SERVER_TYPES as readonly string[]).includes(msg.type) ? ServerMessage : AgentMessage;
      const parsed = schema.safeParse(msg);
      if (!parsed.success) throw new Error(parsed.error.message);
      // nothing silently dropped: every field in the fixture is part of the schema
      expect(parsed.data).toEqual(msg);
    });
  }
});

describe("agents one version behind", () => {
  // what a 0.1.1-era agent sends: no lane pfVersion, no updatePending, no hello sha256
  test("their heartbeats and hellos are still accepted", () => {
    const beat = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
    delete beat.updatePending;
    for (const lane of beat.lanes) delete lane.pfVersion;
    const parsed = AgentMessage.parse(beat);
    expect(parsed.type === "heartbeat" && parsed.lanes[0]?.pfVersion).toBeNull();
    const hello = JSON.parse(readFileSync(join(dir, "hello.json"), "utf8"));
    delete hello.sha256;
    expect(AgentMessage.parse(hello)).toMatchObject({ type: "hello", sha256: null });
  });
});
