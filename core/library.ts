// Pure library logic for Scoped Skills: reading a skill folder, validating its
// frontmatter, matching a scope against a thread's agent and model, and
// writing the materialized library that BB scans as a manifest skill root.
// Nothing here touches the BB plugin API, so it is unit-testable on its own.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_FILES = 2000;

/** Folders and files that never belong in a skill copy. */
const SKIPPED_NAMES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".DS_Store",
  ".venv",
  "venv",
]);

export interface SkillFile {
  /** POSIX-style path relative to the skill folder, e.g. "references/a.md". */
  path: string;
  content: Buffer;
  executable: boolean;
}

/**
 * Who receives a skill. `agents` and `models` are each either null (no
 * restriction) or a non-empty list. Model entries are case-insensitive
 * globs where `*` matches any run of characters.
 */
export interface Scope {
  agents: string[] | null;
  models: string[] | null;
}

export interface ParsedSkill {
  name: string;
  description: string;
  files: SkillFile[];
  totalBytes: number;
}

export class SkillImportError extends Error {}

/** Read and validate the YAML frontmatter at the top of a SKILL.md. */
export function parseFrontmatter(markdown: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (match === null) {
    throw new SkillImportError("SKILL.md has no YAML frontmatter block (--- … ---) at the top.");
  }
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SkillImportError(
      `SKILL.md frontmatter is not valid YAML (${reason}). Quote values that contain ": ", or use a block scalar (description: >-).`,
    );
  }
  if (typeof data !== "object" || data === null) {
    throw new SkillImportError("SKILL.md frontmatter must be a YAML mapping with name and description.");
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME_LENGTH) {
    throw new SkillImportError(
      `Skill name ${JSON.stringify(name)} must be lowercase letters, digits and single hyphens, at most ${MAX_SKILL_NAME_LENGTH} characters.`,
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new SkillImportError(`Skill "${name}" needs a non-empty description.`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillImportError(
      `Skill "${name}" description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}.`,
    );
  }
  return { name, description: description.trim() };
}

/**
 * Read a skill folder from disk. The folder itself may be a symlink (common
 * in ~/.agents/skills); links inside it are followed only when they stay
 * inside the skill folder, so an import never pulls in unrelated files.
 */
export function readSkillFolder(folder: string): ParsedSkill {
  if (!existsSync(folder)) throw new SkillImportError(`No folder at ${folder}.`);
  const root = realpathSync(folder);
  if (!statSync(root).isDirectory()) throw new SkillImportError(`${folder} is not a folder.`);
  const skillMdPath = path.join(root, "SKILL.md");
  if (!existsSync(skillMdPath)) throw new SkillImportError(`${folder} has no SKILL.md.`);
  const { name, description } = parseFrontmatter(readFileSync(skillMdPath, "utf8"));

  const files: SkillFile[] = [];
  let totalBytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (SKIPPED_NAMES.has(entry)) continue;
      const absolute = path.join(dir, entry);
      let target = absolute;
      if (lstatSync(absolute).isSymbolicLink()) {
        target = realpathSync(absolute);
        if (target !== root && !target.startsWith(root + path.sep)) continue;
      }
      const stats = statSync(target);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stats.isFile()) continue;
      totalBytes += stats.size;
      if (totalBytes > MAX_SKILL_BYTES) {
        throw new SkillImportError(`Skill "${name}" is larger than ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
      }
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        content: readFileSync(target),
        executable: (stats.mode & 0o111) !== 0,
      });
      if (files.length > MAX_SKILL_FILES) {
        throw new SkillImportError(`Skill "${name}" has more than ${MAX_SKILL_FILES} files.`);
      }
    }
  };
  walk(root);
  return { name, description, files, totalBytes };
}

/** Normalize user input ("codex, claude-code" or ["all"]) into a scope list. */
export function normalizeList(values: readonly string[] | null | undefined): string[] | null {
  if (values === null || values === undefined) return null;
  const cleaned = [...new Set(values.flatMap((value) => value.split(",")).map((v) => v.trim()).filter(Boolean))];
  if (cleaned.length === 0 || cleaned.some((value) => value.toLowerCase() === "all")) return null;
  return cleaned;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Does a thread running `agent` with `model` receive a skill with `scope`? */
export function scopeMatches(scope: Scope, agent: string, model: string): boolean {
  if (scope.agents !== null && !scope.agents.includes(agent)) return false;
  if (scope.models !== null && !scope.models.some((pattern) => globToRegExp(pattern).test(model))) {
    return false;
  }
  return true;
}

/** Short human label for a scope, e.g. "Codex only" style text built by callers. */
export function describeScope(scope: Scope, agentNames: ReadonlyMap<string, string> = new Map()): string {
  const agents =
    scope.agents === null ? "every agent" : scope.agents.map((id) => agentNames.get(id) ?? id).join(", ");
  const models = scope.models === null ? "" : `, models ${scope.models.join(", ")}`;
  return `${agents}${models}`;
}

/**
 * Replace `libraryDir` with exactly the given skills. Writes to a sibling
 * staging folder first and swaps it in, so BB never scans a half-written
 * library. Returns the names that were written.
 */
export function materializeLibrary(
  libraryDir: string,
  skills: ReadonlyArray<{ name: string; files: ReadonlyArray<SkillFile> }>,
): string[] {
  const parent = path.dirname(libraryDir);
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.library-staging-${stamp}`);
  const retired = path.join(parent, `.library-retired-${stamp}`);
  mkdirSync(staging, { recursive: true });
  try {
    for (const skill of skills) {
      for (const file of skill.files) {
        const destination = path.join(staging, skill.name, ...file.path.split("/"));
        if (!destination.startsWith(path.join(staging, skill.name) + path.sep)) {
          throw new SkillImportError(`Refusing to write ${file.path} outside skill "${skill.name}".`);
        }
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file.content, { mode: file.executable ? 0o755 : 0o644 });
      }
    }
    if (existsSync(libraryDir)) renameSync(libraryDir, retired);
    renameSync(staging, libraryDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(retired, { recursive: true, force: true });
  }
  return skills.map((skill) => skill.name);
}
