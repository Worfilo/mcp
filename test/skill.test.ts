import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { loadSkill } from "../src/skill.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
// tool names from the README's Tools table rows
const tools = [...readme.matchAll(/^\| `([a-z_]+)` \| `[a-z_]+:[a-z]+` \|/gm)].map((match) => match[1]);

it("parses the bundled skill", () => {
  const skill = loadSkill();
  expect(skill.name).toBe("worfilo-workflows");
  expect(skill.body.startsWith("# Building Worfilo workflows")).toBe(true);
});

it("teaches every tool the README lists", () => {
  const { body } = loadSkill();
  expect(tools.length).toBeGreaterThan(20);
  expect(tools.filter((tool) => !body.includes(`\`${tool}\``))).toEqual([]);
});
