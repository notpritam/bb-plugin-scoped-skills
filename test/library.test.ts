import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  materializeLibrary,
  normalizeList,
  parseFrontmatter,
  readSkillFolder,
  scopeMatches,
  SkillImportError,
} from "../core/library.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "scoped-skills-"));

function makeSkill(root: string, name: string, description = `${name} does a thing.`) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "references"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  writeFileSync(path.join(dir, "references", "notes.md"), "notes");
  return dir;
}

test("parseFrontmatter rejects an unquoted ': ' the way BB's strict parser does", () => {
  assert.throws(
    () => parseFrontmatter("---\nname: x\ndescription: use when motion: adding states\n---\n"),
    SkillImportError,
  );
  assert.deepEqual(parseFrontmatter("---\nname: x\ndescription: >-\n  use when motion: adding states\n---\n"), {
    name: "x",
    description: "use when motion: adding states",
  });
});

test("parseFrontmatter validates the name", () => {
  assert.throws(() => parseFrontmatter("---\nname: Bad_Name\ndescription: d\n---\n"), /lowercase/);
  assert.throws(() => parseFrontmatter("no frontmatter"), /frontmatter/);
});

test("readSkillFolder follows a symlinked skill folder and skips junk", () => {
  const root = tmp();
  const real = makeSkill(root, "brandkit");
  mkdirSync(path.join(real, "__pycache__"));
  writeFileSync(path.join(real, "__pycache__", "x.pyc"), "junk");
  const outside = path.join(root, "secret.txt");
  writeFileSync(outside, "not part of the skill");
  symlinkSync(outside, path.join(real, "escape.txt"));
  const link = path.join(root, "linked");
  symlinkSync(real, link);

  const skill = readSkillFolder(link);
  assert.equal(skill.name, "brandkit");
  assert.deepEqual(
    skill.files.map((file) => file.path),
    ["SKILL.md", "references/notes.md"],
  );
});

test("normalizeList treats 'all' and empty as no restriction", () => {
  assert.equal(normalizeList(["all"]), null);
  assert.equal(normalizeList([]), null);
  assert.equal(normalizeList(null), null);
  assert.deepEqual(normalizeList(["codex, claude-code", "codex"]), ["codex", "claude-code"]);
});

test("scopeMatches checks agents and model globs", () => {
  const codexOnly = { agents: ["codex"], models: null };
  assert.equal(scopeMatches(codexOnly, "codex", "gpt-5.5"), true);
  assert.equal(scopeMatches(codexOnly, "claude-code", "claude-opus-5-5"), false);
  const gpt5 = { agents: null, models: ["gpt-5*"] };
  assert.equal(scopeMatches(gpt5, "codex", "GPT-5.5-codex"), true);
  assert.equal(scopeMatches(gpt5, "codex", "o4-mini"), false);
  assert.equal(scopeMatches({ agents: null, models: null }, "anything", ""), true);
});

test("materializeLibrary replaces the library with exactly the given skills", () => {
  const root = tmp();
  const libraryDir = path.join(root, "library");
  const first = readSkillFolder(makeSkill(root, "one"));
  const second = readSkillFolder(makeSkill(root, "two"));
  materializeLibrary(libraryDir, [first, second]);
  assert.ok(existsSync(path.join(libraryDir, "one", "references", "notes.md")));
  materializeLibrary(libraryDir, [second]);
  assert.equal(existsSync(path.join(libraryDir, "one")), false);
  assert.match(readFileSync(path.join(libraryDir, "two", "SKILL.md"), "utf8"), /name: two/);
});
