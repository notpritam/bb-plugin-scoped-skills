// Scope matching shared by the server and the page. Pure: no Node APIs, so
// app.tsx can import it to preview scopes and project globs without a
// round-trip.

/**
 * Who receives a skill. Each field is either null (no restriction) or a
 * non-empty list. Model and project entries are case-insensitive globs where
 * `*` matches any run of characters; a project entry matches the project's
 * id, name, or git remote URL (e.g. `*emergentbase/*` covers every repo of
 * one GitHub org).
 */
export interface Scope {
  agents: string[] | null;
  models: string[] | null;
  projects: string[] | null;
}

/** The parts of a BB project a project glob can match. */
export interface ProjectRef {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
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

/**
 * Does a thread running `agent` with `model`, in `project`, receive a skill
 * with `scope`? A project-scoped skill never matches when the project is
 * unknown.
 */
export function scopeMatches(scope: Scope, agent: string, model: string, project: ProjectRef | null = null): boolean {
  if (scope.agents !== null && !scope.agents.includes(agent)) return false;
  if (scope.models !== null && !scope.models.some((pattern) => globToRegExp(pattern).test(model))) {
    return false;
  }
  if (scope.projects !== null && (project === null || !projectMatches(scope.projects, project))) return false;
  return true;
}

/** Does any glob match the project's id, name, or git remote URL? */
export function projectMatches(globs: readonly string[], project: ProjectRef): boolean {
  const candidates = [project.id, project.name, project.gitRemoteUrl].filter((v): v is string => Boolean(v));
  return globs.some((pattern) => candidates.some((value) => globToRegExp(pattern).test(value)));
}

/** Short human label for a scope, e.g. "Codex only" style text built by callers. */
export function describeScope(scope: Scope, agentNames: ReadonlyMap<string, string> = new Map()): string {
  const agents =
    scope.agents === null ? "every agent" : scope.agents.map((id) => agentNames.get(id) ?? id).join(", ");
  const models = scope.models === null ? "" : `, models ${scope.models.join(", ")}`;
  const projects = scope.projects === null ? "" : `, projects ${scope.projects.join(", ")}`;
  return `${agents}${models}${projects}`;
}
