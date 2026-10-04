import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";

const root = mkdtempSync(path.join(os.tmpdir(), "scoped-skills-plugin-"));
process.env.SCOPED_SKILLS_LIBRARY_DIR = path.join(root, "library");
const { default: plugin } = await import("../server.ts");

function makeSkill(name: string) {
  const dir = path.join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\n# ${name}\n`);
  return dir;
}

const providers = [
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
];

async function load() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "scoped-skills",
    agentSkillIds: ["scoped-skills", "brandkit", "gpt-only", "everywhere"],
    sdk: { providers: { list: async () => providers as never } },
  });
  await plugin(bb);
  return harness;
}

const context = (id: string, model: string) =>
  makePluginAgentConfigurationContext({ provider: { id, model, capabilities: { supportsNativeUserQuestion: false } } });

test("each thread only receives the scoped skills its agent and model match", async () => {
  const harness = await load();
  const cli = (args: string[]) => harness.behavior.runCli(args);

  assert.equal((await cli(["import", makeSkill("brandkit"), "--agents", "codex"])).exitCode, 0);
  assert.equal((await cli(["import", makeSkill("gpt-only"), "--agents", "all", "--models", "gpt-5*"])).exitCode, 0);
  assert.equal((await cli(["import", makeSkill("everywhere"), "--agents", "all"])).exitCode, 0);
  assert.ok(existsSync(path.join(root, "library", "brandkit", "SKILL.md")));

  const claude = await harness.behavior.resolveAgentConfiguration(context("claude-code", "claude-opus-5-5"));
  assert.deepEqual([...claude.skills].sort(), ["everywhere", "scoped-skills"]);

  const codex = await harness.behavior.resolveAgentConfiguration(context("codex", "gpt-5.5"));
  assert.deepEqual([...codex.skills].sort(), ["brandkit", "everywhere", "gpt-only", "scoped-skills"]);
  assert.deepEqual(
    codex.tools.map((tool) => tool.name).sort(),
    ["scoped_skills_import", "scoped_skills_list", "scoped_skills_set_scope"],
  );
});

test("scope changes and removals take effect on the next resolution", async () => {
  const harness = await load();
  await harness.behavior.runCli(["import", makeSkill("brandkit"), "--agents", "codex", "--replace"]);
  await harness.behavior.runCli(["scope", "brandkit", "--agents", "claude-code"]);
  let claude = await harness.behavior.resolveAgentConfiguration(context("claude-code", "x"));
  assert.ok(claude.skills.includes("brandkit"));

  await harness.behavior.runCli(["remove", "brandkit"]);
  claude = await harness.behavior.resolveAgentConfiguration(context("claude-code", "x"));
  assert.equal(claude.skills.includes("brandkit"), false);
  assert.equal(existsSync(path.join(root, "library", "brandkit")), false);
});

test("unknown agent ids and duplicate imports are rejected", async () => {
  const harness = await load();
  const typo = await harness.behavior.runCli(["import", makeSkill("everywhere"), "--agents", "codx", "--replace"]);
  assert.equal(typo.exitCode, 1);
  assert.match(String(typo.stderr), /Unknown agent "codx"/);

  assert.equal((await harness.behavior.runCli(["import", makeSkill("everywhere"), "--agents", "all"])).exitCode, 0);
  const dup = await harness.behavior.runCli(["import", makeSkill("everywhere"), "--agents", "all"]);
  assert.equal(dup.exitCode, 1);
  assert.match(String(dup.stderr), /already exists/);
});

test("the list tool reports scopes", async () => {
  const harness = await load();
  await harness.behavior.runCli(["import", makeSkill("everywhere"), "--agents", "codex"]);
  const result = await harness.behavior.callAgentTool("scoped_skills_list", {});
  assert.match(JSON.stringify(result), /everywhere/);
});
