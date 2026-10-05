// bb-plugin-scoped-skills — skills that only some agents receive.
//
// BB gives every skill in ~/.bb/skills to every thread. This plugin keeps a
// library of skills that each carry a scope (which agents, optionally which
// models) and, through bb.agents.configure, hands a thread only the skills
// whose scope matches the thread's agent and model.
//
// Storage: the plugin database is the source of truth (skills, files,
// scopes). On load and after every change the library is written to
// ./library, a manifest skill root BB scans. Keeping the truth in the
// database means a plugin update, which replaces the plugin folder, never
// loses the library.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  materializeLibrary,
  normalizeList,
  readSkillFolder,
  scopeMatches,
  SkillImportError,
  type ProjectRef,
  type Scope,
  type SkillFile,
} from "./core/library.ts";

/** The plugin's own usage guide; always injected so agents know the tools. */
const GUIDE_SKILL = "scoped-skills";
const TOOL_NAMES = ["scoped_skills_list", "scoped_skills_set_scope", "scoped_skills_import"] as const;
const LIBRARY_CHANGED = "library-changed";

const scopeSchema = z.object({
  agents: z.array(z.string()).nullable(),
  models: z.array(z.string()).nullable(),
  projects: z.array(z.string()).nullable(),
});

const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: scopeSchema,
  fileCount: z.number(),
  totalBytes: z.number(),
  source: z.string().nullable(),
  updatedAt: z.string(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

const agentSchema = z.object({ id: z.string(), name: z.string() });
export type Agent = z.infer<typeof agentSchema>;

const projectSchema = z.object({ id: z.string(), name: z.string(), gitRemoteUrl: z.string().nullable() });
export type Project = z.infer<typeof projectSchema>;

export const rpcContract = defineRpcContract({
  library_list: {
    input: z.null(),
    output: z.object({
      skills: z.array(skillSummarySchema),
      agents: z.array(agentSchema),
      projects: z.array(projectSchema),
    }),
  },
  library_set_scope: {
    input: z.object({
      name: z.string(),
      agents: z.array(z.string()).nullable(),
      models: z.array(z.string()).nullable(),
      projects: z.array(z.string()).nullable(),
    }),
    output: skillSummarySchema,
  },
  library_import: {
    input: z.object({
      path: z.string().trim().min(1),
      agents: z.array(z.string()).nullable(),
      models: z.array(z.string()).nullable(),
      projects: z.array(z.string()).nullable(),
      replace: z.boolean(),
    }),
    output: skillSummarySchema,
  },
  library_get: {
    input: z.object({ name: z.string() }),
    output: z.object({
      skill: skillSummarySchema,
      skillMd: z.string(),
      files: z.array(z.object({ path: z.string(), bytes: z.number() })),
    }),
  },
  library_remove: {
    input: z.object({ name: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  library_preview: {
    input: z.object({ agent: z.string(), model: z.string(), project: z.string().nullable() }),
    output: z.object({ included: z.array(z.string()), excluded: z.array(z.string()) }),
  },
});

/** Walk up from this module to the folder holding the plugin's package.json. */
function findPluginRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Scoped Skills could not find its plugin folder.");
}

function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
}

interface SkillRow {
  name: string;
  description: string;
  agents: string | null;
  models: string | null;
  projects: string | null;
  source: string | null;
  updated_at: string;
}

export default async function plugin(bb: BbPluginApi) {
  // SCOPED_SKILLS_LIBRARY_DIR exists for tests, so a test run never rewrites
  // the live plugin's library folder.
  const libraryDir = process.env.SCOPED_SKILLS_LIBRARY_DIR ?? path.join(findPluginRoot(), "library");
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS skills (
       name TEXT PRIMARY KEY,
       description TEXT NOT NULL,
       agents TEXT,
       models TEXT,
       source TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS skill_files (
       skill TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
       path TEXT NOT NULL,
       content BLOB NOT NULL,
       executable INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (skill, path)
     )`,
    `ALTER TABLE skills ADD COLUMN projects TEXT`,
  ]);
  db.pragma("foreign_keys = ON");

  const parseList = (value: string | null): string[] | null =>
    value === null ? null : (JSON.parse(value) as string[]);
  const scopeOf = (row: SkillRow): Scope => ({
    agents: parseList(row.agents),
    models: parseList(row.models),
    projects: parseList(row.projects),
  });
  const encodeList = (list: string[] | null) => (list === null ? null : JSON.stringify(list));

  /** In-memory scopes for the synchronous configure callback. */
  let scopes = new Map<string, Scope>();

  function rows(): SkillRow[] {
    return db.prepare(`SELECT name, description, agents, models, projects, source, updated_at FROM skills ORDER BY name`).all() as SkillRow[];
  }

  function summarize(row: SkillRow): SkillSummary {
    const stats = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM skill_files WHERE skill = ?`)
      .get(row.name) as { n: number; bytes: number };
    return {
      name: row.name,
      description: row.description,
      scope: scopeOf(row),
      fileCount: stats.n,
      totalBytes: stats.bytes,
      // Home-relative, so the page, CLI and tools never print the username.
      source: row.source === null ? null : row.source.replace(os.homedir(), "~"),
      updatedAt: row.updated_at,
    };
  }

  /** Write ./library from the database, then publish the new scopes. */
  function sync(): void {
    const all = rows();
    const filesFor = db.prepare(`SELECT path, content, executable FROM skill_files WHERE skill = ? ORDER BY path`);
    materializeLibrary(
      libraryDir,
      all.map((row) => ({
        name: row.name,
        files: (filesFor.all(row.name) as Array<{ path: string; content: Buffer; executable: number }>).map(
          (file): SkillFile => ({ path: file.path, content: file.content, executable: file.executable === 1 }),
        ),
      })),
    );
    scopes = new Map(all.map((row) => [row.name, scopeOf(row)]));
    bb.realtime.publish(LIBRARY_CHANGED, { count: all.length });
  }

  async function listAgents(): Promise<Agent[]> {
    try {
      const providers = await bb.sdk.providers.list();
      return providers.map((provider) => ({ id: provider.id, name: provider.displayName }));
    } catch (error) {
      bb.log.warn(`could not list providers: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async function listProjects(): Promise<Project[]> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.map((project) => ({ id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl ?? null }));
    } catch (error) {
      bb.log.warn(`could not list projects: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Reject agent ids BB does not know, so a typo cannot hide a skill forever. */
  async function checkAgents(agents: string[] | null): Promise<void> {
    if (agents === null) return;
    const known = await listAgents();
    if (known.length === 0) return;
    const unknown = agents.filter((id) => !known.some((agent) => agent.id === id));
    if (unknown.length > 0) {
      throw new SkillImportError(
        `Unknown agent ${unknown.map((id) => `"${id}"`).join(", ")}. Known agents: ${known.map((a) => a.id).join(", ")}.`,
      );
    }
  }

  function getRow(name: string): SkillRow {
    const row = db
      .prepare(`SELECT name, description, agents, models, projects, source, updated_at FROM skills WHERE name = ?`)
      .get(name) as SkillRow | undefined;
    if (row === undefined) throw new SkillImportError(`No scoped skill named "${name}". Run "bb scoped-skills list".`);
    return row;
  }

  async function importSkill(input: {
    path: string;
    agents: string[] | null;
    models: string[] | null;
    projects?: string[] | null;
    replace: boolean;
  }): Promise<SkillSummary> {
    const folder = path.resolve(expandHome(input.path));
    const skill = readSkillFolder(folder);
    if (skill.name === GUIDE_SKILL) {
      throw new SkillImportError(`"${GUIDE_SKILL}" is reserved for this plugin's own guide.`);
    }
    const agents = normalizeList(input.agents);
    const models = normalizeList(input.models);
    const projects = normalizeList(input.projects ?? null);
    await checkAgents(agents);
    const exists = db.prepare(`SELECT 1 FROM skills WHERE name = ?`).get(skill.name) !== undefined;
    if (exists && !input.replace) {
      throw new SkillImportError(`A scoped skill named "${skill.name}" already exists. Pass --replace to overwrite it.`);
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`DELETE FROM skills WHERE name = ?`).run(skill.name);
      db.prepare(
        `INSERT INTO skills (name, description, agents, models, projects, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        skill.name,
        skill.description,
        encodeList(agents),
        encodeList(models),
        encodeList(projects),
        folder,
        now,
        now,
      );
      const insertFile = db.prepare(`INSERT INTO skill_files (skill, path, content, executable) VALUES (?, ?, ?, ?)`);
      for (const file of skill.files) insertFile.run(skill.name, file.path, file.content, file.executable ? 1 : 0);
    })();
    sync();
    bb.log.info(`imported skill ${skill.name} (${skill.files.length} files)`);
    return summarize(getRow(skill.name));
  }

  async function setScope(
    name: string,
    agentsInput: string[] | null,
    modelsInput: string[] | null,
    projectsInput: string[] | null,
  ): Promise<SkillSummary> {
    getRow(name);
    const agents = normalizeList(agentsInput);
    const models = normalizeList(modelsInput);
    const projects = normalizeList(projectsInput);
    await checkAgents(agents);
    db.prepare(`UPDATE skills SET agents = ?, models = ?, projects = ?, updated_at = ? WHERE name = ?`).run(
      encodeList(agents),
      encodeList(models),
      encodeList(projects),
      new Date().toISOString(),
      name,
    );
    sync();
    return summarize(getRow(name));
  }

  function removeSkill(name: string): boolean {
    const result = db.prepare(`DELETE FROM skills WHERE name = ?`).run(name);
    if (result.changes === 0) return false;
    sync();
    return true;
  }

  function preview(agent: string, model: string, project: ProjectRef | null): { included: string[]; excluded: string[] } {
    const included: string[] = [];
    const excluded: string[] = [];
    for (const [name, scope] of scopes) (scopeMatches(scope, agent, model, project) ? included : excluded).push(name);
    return { included, excluded };
  }

  sync();

  // The core of the plugin: per thread, select only the skills whose scope
  // matches. Must stay synchronous and only name skills that exist on disk.
  bb.agents.configure((context) => ({
    tools: [...TOOL_NAMES],
    skills: [
      GUIDE_SKILL,
      ...preview(context.provider.id, context.provider.model, {
        id: context.project.id,
        name: context.project.name,
        gitRemoteUrl: context.project.gitRemoteUrl,
      }).included,
    ],
  }));

  bb.rpc.register(rpcContract, {
    library_list: async () => ({
      skills: rows().map(summarize),
      agents: await listAgents(),
      projects: await listProjects(),
    }),
    library_set_scope: ({ name, agents, models, projects }) => setScope(name, agents, models, projects),
    library_import: (input) => importSkill(input),
    library_get: ({ name }) => {
      const skill = summarize(getRow(name));
      const files = db
        .prepare(`SELECT path, LENGTH(content) AS bytes FROM skill_files WHERE skill = ? ORDER BY path`)
        .all(name) as Array<{ path: string; bytes: number }>;
      const md = db.prepare(`SELECT content FROM skill_files WHERE skill = ? AND path = 'SKILL.md'`).get(name) as
        | { content: Buffer }
        | undefined;
      return { skill, skillMd: md ? Buffer.from(md.content).toString("utf8") : "", files };
    },
    library_remove: ({ name }) => ({ removed: removeSkill(name) }),
    library_preview: async ({ agent, model, project }) => {
      const ref = project === null ? null : ((await listProjects()).find((p) => p.id === project) ?? null);
      return preview(agent, model, ref);
    },
  });

  // ---- Agent tools -------------------------------------------------------

  const formatSkill = (skill: SkillSummary, agentNames: Map<string, string>) => {
    const who = skill.scope.agents === null ? "all agents" : skill.scope.agents.map((id) => agentNames.get(id) ?? id).join(", ");
    const models = skill.scope.models === null ? "" : ` · models: ${skill.scope.models.join(", ")}`;
    const projects = skill.scope.projects === null ? "" : ` · projects: ${skill.scope.projects.join(", ")}`;
    return `- ${skill.name} → ${who}${models}${projects}`;
  };

  bb.agents.registerTool({
    name: "scoped_skills_list",
    description:
      "List the skills managed by the Scoped Skills plugin and which agents (and models) receive each one, plus which agent this thread runs on. Use when the user asks which skills an agent gets, why a skill is missing in this thread, or before changing a skill's scope.",
    instructions:
      "Scoped Skills gives some skills only to certain agents. If a skill the user mentions is missing here, call scoped_skills_list before assuming it does not exist.",
    presentation: { label: { pending: "Reading scoped skills", completed: "Read scoped skills" } },
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      const agents = await listAgents();
      const names = new Map(agents.map((agent) => [agent.id, agent.name]));
      let current = "unknown";
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        current = names.get(thread.providerId) ?? thread.providerId;
      } catch {
        // The list is still useful without the current thread's agent.
      }
      const skills = rows().map(summarize);
      if (skills.length === 0) return `No scoped skills yet. This thread runs on ${current}.`;
      return [
        `This thread runs on ${current}. Scope changes apply to new sessions, not this one.`,
        ...skills.map((skill) => formatSkill(skill, names)),
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "scoped_skills_set_scope",
    description:
      "Change which agents (and optionally which models and projects) receive a scoped skill. Only call this when the user asks to restrict, widen, or move a skill. agents: provider ids such as codex or claude-code, or [\"all\"]. models: optional globs such as gpt-5*. projects: optional globs matched against a project's id, name or git remote, such as *emergentbase/*. Omitting models or projects keeps the current value.",
    presentation: { label: { pending: "Updating skill scope", completed: "Updated skill scope" } },
    parameters: z.object({
      name: z.string().min(1),
      agents: z.array(z.string().min(1)).min(1),
      models: z.array(z.string().min(1)).optional(),
      projects: z.array(z.string().min(1)).optional(),
    }),
    async execute({ name, agents, models, projects }) {
      try {
        const current = scopeOf(getRow(name));
        const skill = await setScope(name, agents, models ?? current.models, projects ?? current.projects);
        const names = new Map((await listAgents()).map((agent) => [agent.id, agent.name]));
        return `Updated. ${formatSkill(skill, names).slice(2)}. New threads pick this up; running sessions keep their skills until restarted.`;
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "scoped_skills_import",
    description:
      "Copy a skill folder (one containing SKILL.md) from this machine into the Scoped Skills library with a scope. Only call this when the user asks to add or convert a skill into a scoped skill. The original folder is left untouched; tell the user they can delete it afterwards.",
    presentation: { label: { pending: "Importing skill", completed: "Imported skill" } },
    parameters: z.object({
      path: z.string().min(1),
      agents: z.array(z.string().min(1)).min(1),
      models: z.array(z.string().min(1)).optional(),
      projects: z.array(z.string().min(1)).optional(),
      replace: z.boolean().optional(),
    }),
    async execute({ path: folder, agents, models, projects, replace }) {
      try {
        const skill = await importSkill({
          path: folder,
          agents,
          models: models ?? null,
          projects: projects ?? null,
          replace: replace ?? false,
        });
        const names = new Map((await listAgents()).map((agent) => [agent.id, agent.name]));
        return `Imported ${skill.fileCount} ${skill.fileCount === 1 ? "file" : "files"}. ${formatSkill(skill, names).slice(2)}.`;
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  // ---- CLI ---------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb scoped-skills list [--json]",
    "  bb scoped-skills import <folder> --agents <ids|all> [--models <globs>] [--projects <globs>] [--replace] [--json]",
    "  bb scoped-skills scope <name> --agents <ids|all> [--models <globs|all>] [--projects <globs|all>] [--json]",
    "  bb scoped-skills remove <name> [--json]",
    "  bb scoped-skills preview --agent <id> [--model <model>] [--project <id|name>] [--json]",
    "  bb scoped-skills agents [--json]",
    "",
    "Agent ids come from `bb scoped-skills agents` (e.g. codex, claude-code).",
    "Lists are comma-separated. Globs use * (models: gpt-5*; projects match id, name or",
    "git remote: *emergentbase/*).",
  ].join("\n");

  function takeFlag(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = args[index + 1];
    args.splice(index, value === undefined || value.startsWith("--") ? 1 : 2);
    return value === undefined || value.startsWith("--") ? "" : value;
  }
  function takeBool(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) return false;
    args.splice(index, 1);
    return true;
  }
  const splitList = (value: string | undefined) => (value === undefined ? undefined : value.split(","));

  bb.cli.register({
    name: "scoped-skills",
    summary: "Give skills only to the agents, models and projects that should have them",
    commands: [
      { name: "list", summary: "List scoped skills and who receives them", usage: "bb scoped-skills list [--json]" },
      {
        name: "import",
        summary: "Copy a skill folder into the library with a scope",
        usage: "bb scoped-skills import <folder> --agents <ids|all> [--models <globs>] [--projects <globs>] [--replace]",
      },
      {
        name: "scope",
        summary: "Change which agents/models/projects receive a skill",
        usage: "bb scoped-skills scope <name> --agents <ids|all> [--models <globs|all>] [--projects <globs|all>]",
      },
      { name: "remove", summary: "Delete a skill from the library", usage: "bb scoped-skills remove <name>" },
      {
        name: "preview",
        summary: "Show which scoped skills a thread on an agent/model/project would get",
        usage: "bb scoped-skills preview --agent <id> [--model <model>] [--project <id|name>]",
      },
      { name: "agents", summary: "List the agent ids you can scope to", usage: "bb scoped-skills agents" },
    ],
    async run(argv) {
      const args = [...argv];
      const json = takeBool(args, "--json");
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const fail = (message: string) => ({
        exitCode: 1,
        stderr: message,
        ...(json ? { stdout: JSON.stringify({ ok: false, error: { message } }) } : {}),
      });
      const [command, ...rest] = args;
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
          case "-h":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const skills = rows().map(summarize);
            const names = new Map((await listAgents()).map((agent) => [agent.id, agent.name]));
            return reply(
              skills,
              skills.length === 0 ? "No scoped skills yet." : skills.map((skill) => formatSkill(skill, names).slice(2)).join("\n"),
            );
          }
          case "agents": {
            const agents = await listAgents();
            return reply(agents, agents.map((agent) => `${agent.id}\t${agent.name}`).join("\n"));
          }
          case "import": {
            const agents = takeFlag(rest, "--agents");
            const models = takeFlag(rest, "--models");
            const projects = takeFlag(rest, "--projects");
            const replace = takeBool(rest, "--replace");
            const folder = rest[0];
            if (folder === undefined || rest.length !== 1 || agents === undefined || agents === "") break;
            const skill = await importSkill({
              path: folder,
              agents: splitList(agents) ?? null,
              models: splitList(models) ?? null,
              projects: splitList(projects) ?? null,
              replace,
            });
            const names = new Map((await listAgents()).map((agent) => [agent.id, agent.name]));
            return reply(skill, `Imported ${skill.fileCount} ${skill.fileCount === 1 ? "file" : "files"}: ${formatSkill(skill, names).slice(2)}`);
          }
          case "scope": {
            const agents = takeFlag(rest, "--agents");
            const models = takeFlag(rest, "--models");
            const projects = takeFlag(rest, "--projects");
            const name = rest[0];
            if (name === undefined || rest.length !== 1 || agents === undefined || agents === "") break;
            const current = scopeOf(getRow(name));
            const skill = await setScope(
              name,
              splitList(agents) ?? null,
              models === undefined ? current.models : (splitList(models) ?? null),
              projects === undefined ? current.projects : (splitList(projects) ?? null),
            );
            const names = new Map((await listAgents()).map((agent) => [agent.id, agent.name]));
            return reply(skill, formatSkill(skill, names).slice(2));
          }
          case "remove": {
            const name = rest[0];
            if (name === undefined || rest.length !== 1) break;
            if (!removeSkill(name)) return fail(`No scoped skill named "${name}".`);
            return reply({ removed: true, name }, `Removed ${name}.`);
          }
          case "preview": {
            const agent = takeFlag(rest, "--agent");
            const model = takeFlag(rest, "--model") ?? "";
            const projectArg = takeFlag(rest, "--project");
            if (agent === undefined || agent === "" || rest.length !== 0) break;
            let project: ProjectRef | null = null;
            if (projectArg !== undefined && projectArg !== "") {
              const all = await listProjects();
              project = all.find((p) => p.id === projectArg || p.name.toLowerCase() === projectArg.toLowerCase()) ?? null;
              if (project === null) return fail(`No project "${projectArg}". Use a project id or exact name from \`bb project list\`.`);
            }
            const result = preview(agent, model, project);
            return reply(
              result,
              [
                `A ${agent}${model ? ` (${model})` : ""} thread${project ? ` in ${project.name}` : ""} gets: ${result.included.join(", ") || "none"}`,
                `Withheld: ${result.excluded.join(", ") || "none"}`,
              ].join("\n"),
            );
          }
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
