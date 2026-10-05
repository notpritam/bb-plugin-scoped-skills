// Scoped Skills — the library page.
//
// Two views behind one nav panel, the same list → detail pattern as BB's own
// "My skills": the library (search, a thread preview, compact rows) and one
// page per skill (who gets it, its SKILL.md, its files). The subPath routes
// between them, so browser back/forward walks the panel's history. All state
// lives on the server; both views refetch on "library-changed".
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Agent, Project, rpcContract, SkillSummary } from "./server";
import { projectMatches, scopeMatches, type Scope } from "./core/scope";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PANEL = "library";
const SKILL_PREFIX = "skill/";

type Library = { skills: SkillSummary[]; agents: Agent[]; projects: Project[] };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function useLibrary() {
  const rpc = useRpc<typeof rpcContract>();
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("library_list").then(
      (result) => {
        setLibrary(result);
        setError(null);
      },
      (cause) => setError(message(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("library-changed", refetch);
  return { rpc, library, error, refetch };
}

function usePanelNav() {
  const navigate = useBbNavigate();
  return useMemo(
    () => ({
      toLibrary: () => navigate.toPluginPanel(PANEL, { subPath: "" }),
      toSkill: (name: string) =>
        navigate.toPluginPanel(PANEL, { subPath: SKILL_PREFIX + encodeURIComponent(name) }),
    }),
    [navigate],
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Drop the YAML frontmatter; the page shows name and description itself. */
const stripFrontmatter = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();

// ---- Small building blocks ---------------------------------------------------

/** The same quiet badge BB uses for "Included" on My skills. */
function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function AgentMark({ agentId, className }: { agentId: string; className?: string }) {
  // The full provider record carries the logo; an id alone only gets the fallback.
  const { providers } = useProviders();
  const provider = providers.find((candidate) => candidate.id === agentId) ?? { id: agentId };
  return (
    <ProviderIcon
      providerKind="agent"
      provider={provider}
      fallback="Bot"
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}

/** Scope as badges: who, which models, which projects. */
function ScopeBadges({ scope, agents }: { scope: Scope; agents: Agent[] }) {
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;
  return (
    <>
      {scope.agents === null ? (
        scope.models === null && scope.projects === null ? <Badge>Every agent</Badge> : null
      ) : (
        scope.agents.map((id) => (
          <Badge key={id}>
            <AgentMark agentId={id} className="size-3" />
            {agentName(id)}
          </Badge>
        ))
      )}
      {scope.models?.map((glob) => (
        <Badge key={`m:${glob}`} title="Model" className="font-mono">
          {glob}
        </Badge>
      ))}
      {scope.projects?.map((glob) => (
        <Badge key={`p:${glob}`} title="Project">
          <Icon name="Folder" className="size-3" />
          <span className="font-mono">{glob}</span>
        </Badge>
      ))}
    </>
  );
}

function Notice({ tone = "error", children, action }: { tone?: "error" | "warning"; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
      )}
    >
      <Icon name={tone === "error" ? "AlertCircle" : "AlertTriangle"} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Chips plus a free-text field. Enter or comma adds; Backspace on empty removes the last. */
function TokenInput({
  value,
  onChange,
  placeholder,
  label,
  suggestions,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const commit = (raw: string) => {
    const added = raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !value.includes(part));
    setDraft("");
    if (added.length > 0) onChange([...value, ...new Set(added)]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input px-1.5 py-1 focus-within:ring-1 focus-within:ring-ring">
      {value.map((token) => (
        <span
          key={token}
          className="inline-flex h-6 items-center gap-1 rounded bg-state-active pl-2 pr-1 font-mono text-xs text-foreground"
        >
          {token}
          <button
            type="button"
            onClick={() => onChange(value.filter((item) => item !== token))}
            aria-label={`Remove ${token}`}
            className="grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="X" className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() !== "" && commit(draft)}
        placeholder={value.length === 0 ? placeholder : "Add another"}
        aria-label={label}
        list={suggestions ? listId : undefined}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-6 min-w-[9rem] flex-1 bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground",
          draft !== "" && "font-mono",
        )}
      />
      {suggestions ? (
        <datalist id={listId}>
          {suggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

/** "Every agent" or a chosen set, with each agent's own logo. */
function AgentPicker({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: Agent[];
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
}) {
  const [onlyMode, setOnlyMode] = useState(value !== null);
  useEffect(() => setOnlyMode(value !== null), [value]);
  const chosen = value ?? [];
  const segment = (active: boolean) =>
    cn(
      "h-7 rounded px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
      active ? "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.25)]" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Which agents" className="inline-flex rounded-md bg-state-hover p-0.5">
        <button
          type="button"
          role="radio"
          aria-checked={!onlyMode}
          disabled={disabled}
          onClick={() => {
            setOnlyMode(false);
            onChange(null);
          }}
          className={segment(!onlyMode)}
        >
          Every agent
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={onlyMode}
          disabled={disabled}
          onClick={() => setOnlyMode(true)}
          className={segment(onlyMode)}
        >
          Only these
        </button>
      </div>
      {onlyMode ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Agents">
          {agents.map((agent) => {
            const active = chosen.includes(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => {
                  const next = active ? chosen.filter((id) => id !== agent.id) : [...chosen, agent.id];
                  if (next.length > 0) onChange(next);
                  else onChange([]);
                }}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
                  active
                    ? "border-foreground/30 bg-state-active text-foreground"
                    : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
                )}
              >
                <AgentMark agentId={agent.id} />
                {agent.name}
                {active ? <Icon name="Check" className="size-3" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---- Library view -----------------------------------------------------------

type Preview = { agent: string; model: string; project: string | null };

function PreviewBar({
  library,
  preview,
  onChange,
  included,
}: {
  library: Library;
  preview: Preview;
  onChange: (next: Preview) => void;
  included: number;
}) {
  const select =
    "h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
      <span>A thread on</span>
      <select
        aria-label="Agent"
        value={preview.agent}
        onChange={(event) => onChange({ ...preview, agent: event.target.value })}
        className={select}
      >
        {library.agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <span>using</span>
      <Input
        value={preview.model}
        onChange={(event) => onChange({ ...preview, model: event.target.value })}
        placeholder="any model"
        aria-label="Model"
        spellCheck={false}
        className="h-8 w-36 font-mono text-xs placeholder:font-sans"
      />
      <span>in</span>
      <select
        aria-label="Project"
        value={preview.project ?? ""}
        onChange={(event) => onChange({ ...preview, project: event.target.value === "" ? null : event.target.value })}
        className={cn(select, "max-w-[12rem]")}
      >
        <option value="">any project</option>
        {library.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <span className="ml-auto pl-2 text-foreground" aria-live="polite">
        gets <strong className="font-semibold tabular-nums">{included}</strong> of{" "}
        <span className="tabular-nums">{library.skills.length}</span>
      </span>
    </div>
  );
}

function SkillRow({
  skill,
  agents,
  withheld,
  onOpen,
}: {
  skill: SkillSummary;
  agents: Agent[];
  withheld: boolean | null;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
      >
        <div className={cn("min-w-0 flex-1 transition-opacity", withheld && "opacity-45")}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-sm font-medium text-foreground">{skill.name}</span>
            <ScopeBadges scope={skill.scope} agents={agents} />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{skill.description}</p>
        </div>
        {withheld === null ? null : withheld ? (
          <Badge>Withheld</Badge>
        ) : (
          <Badge className="border-primary/40 text-primary">
            <Icon name="Check" className="size-3" />
            Gets it
          </Badge>
        )}
        <Icon
          name="ChevronRight"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <ul aria-label="Loading skills" className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {[0, 1, 2].map((key) => (
        <li key={key} className="space-y-2 px-4 py-3.5">
          <div className="h-3.5 w-40 animate-pulse rounded bg-state-hover" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-state-hover" />
        </li>
      ))}
    </ul>
  );
}

function LibraryView() {
  const { library, error, refetch } = useLibrary();
  const nav = usePanelNav();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const projectRef = useMemo(
    () => (preview?.project ? (library?.projects.find((project) => project.id === preview.project) ?? null) : null),
    [library, preview],
  );
  const gets = useCallback(
    (skill: SkillSummary) => (preview ? scopeMatches(skill.scope, preview.agent, preview.model.trim(), projectRef) : true),
    [preview, projectRef],
  );

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = (library?.skills ?? []).filter((skill) => {
    const text = `${skill.name} ${skill.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const includedCount = library ? library.skills.filter(gets).length : 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl px-4 pb-10 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Skills here reach only the agents, models and projects you choose. Anything in{" "}
          <code className="text-foreground">~/.bb/skills</code> still reaches every thread.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2 [&>button]:flex-1 sm:flex-nowrap sm:[&>button]:flex-none">
          <div className="relative min-w-0 basis-full sm:basis-0 sm:flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search scoped skills"
              aria-label="Search scoped skills"
              className="h-9 pl-8"
            />
          </div>
          <Button
            variant="outline"
            aria-pressed={preview !== null}
            disabled={!library || library.agents.length === 0}
            onClick={() =>
              setPreview((current) =>
                current ? null : { agent: library?.agents[0]?.id ?? "", model: "", project: null },
              )
            }
            className={cn(preview && "bg-state-active text-foreground")}
          >
            <Icon name="Eye" className="size-4" />
            Preview
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Icon name="Plus" className="size-4" />
            Import skill
          </Button>
        </div>

        {preview && library ? (
          <div className="mt-2">
            <PreviewBar library={library} preview={preview} onChange={setPreview} included={includedCount} />
          </div>
        ) : null}

        <div className="mt-4">
          {error !== null && library === null ? (
            <Notice
              action={
                <Button variant="outline" size="sm" onClick={refetch}>
                  Retry
                </Button>
              }
            >
              Couldn’t load the library. {error}
            </Notice>
          ) : library === null ? (
            <RowsSkeleton />
          ) : library.skills.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-medium text-foreground">No scoped skills yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Import a skill folder and choose which agents, models or projects get it. Every other thread
                won’t see it.
              </p>
              <Button className="mt-4" onClick={() => setImportOpen(true)}>
                <Icon name="Plus" className="size-4" />
                Import skill
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                Or from a terminal: <code>bb scoped-skills import ~/.claude/skills/&lt;name&gt; --agents codex</code>
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No scoped skills match “{query.trim()}”.
            </div>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {visible.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  agents={library.agents}
                  withheld={preview ? !gets(skill) : null}
                  onOpen={() => nav.toSkill(skill.name)}
                />
              ))}
            </ul>
          )}
        </div>

        {library && library.skills.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {plural(library.skills.length, "scoped skill")}. Changes apply to new threads.
          </p>
        ) : null}
      </div>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        agents={library?.agents ?? []}
        onImported={(name) => nav.toSkill(name)}
      />
    </div>
  );
}

// ---- Import -----------------------------------------------------------------

function ImportDialog({
  open,
  onOpenChange,
  agents,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  onImported: (name: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [path, setPath] = useState("");
  const [who, setWho] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setPath("");
      setWho(null);
      setError(null);
    }
  }, [open]);
  const noAgents = who !== null && who.length === 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (path.trim() === "" || busy || noAgents) return;
    setBusy(true);
    setError(null);
    try {
      const skill = await rpc.call("library_import", {
        path: path.trim(),
        agents: who,
        models: null,
        projects: null,
        replace: false,
      });
      toast.success(`Imported ${skill.name}`);
      onOpenChange(false);
      onImported(skill.name);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Translucent themes (e.g. Transparency) show the page through the
          dialog; blurring it keeps the form legible on any theme. */}
      <DialogContent className="backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle>Import a skill</DialogTitle>
          <DialogDescription>
            Copies a skill folder on the BB machine into the library. The original stays where it is.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">Folder with a SKILL.md</span>
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="~/.claude/skills/brandkit"
              spellCheck={false}
              autoFocus
              className="font-mono text-xs"
            />
          </label>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Who gets it</span>
            <AgentPicker agents={agents} value={who} onChange={setWho} disabled={busy} />
            <p className="text-xs text-muted-foreground">You can add model and project limits after importing.</p>
          </div>
          {error ? <Notice>{error}</Notice> : null}
          <p className="text-xs text-muted-foreground">
            Delete the original afterwards. A copy left in <code>~/.bb/skills</code>, <code>~/.claude/skills</code> or{" "}
            <code>~/.codex/skills</code> still reaches every agent.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || path.trim() === "" || noAgents}>
              {busy ? <Icon name="Loading" className="size-4 animate-spin" /> : null}
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Skill view -------------------------------------------------------------

type SkillDetail = { skill: SkillSummary; skillMd: string; files: Array<{ path: string; bytes: number }> };

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-2 px-4 py-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="pt-1.5 text-sm font-medium text-foreground">{label}</div>
      <div className="min-w-0 space-y-2">
        {children}
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
    </div>
  );
}

function ProjectReadout({ globs, projects }: { globs: string[]; projects: Project[] }) {
  if (globs.length === 0) return <>Any project. Matches a project’s name, id or git remote, e.g. <code>*my-org/*</code>.</>;
  const matched = projects.filter((project) => projectMatches(globs, project));
  if (matched.length === 0) {
    return (
      <span className="text-amber-700 dark:text-amber-300">
        Matches none of your {plural(projects.length, "project")} yet, so no thread gets this skill.
      </span>
    );
  }
  const shown = matched.slice(0, 4).map((project) => project.name);
  return (
    <>
      Matches {plural(matched.length, "project")}: {shown.join(", ")}
      {matched.length > shown.length ? ` and ${matched.length - shown.length} more` : ""}.
    </>
  );
}

function SkillView({ name }: { name: string }) {
  const { rpc, library } = useLibrary();
  const nav = usePanelNav();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [saveState]);
  const saving = saveState === "saving";

  const load = useCallback(() => {
    rpc.call("library_get", { name }).then(
      (result) => {
        setDetail(result);
        setError(null);
      },
      (cause) => setError(message(cause)),
    );
  }, [rpc, name]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);
  useRealtime("library-changed", load);

  const save = async (next: Scope) => {
    if (!detail) return;
    const previous = detail;
    setDetail({ ...detail, skill: { ...detail.skill, scope: next } });
    setSaveState("saving");
    try {
      const skill = await rpc.call("library_set_scope", { name, ...next });
      setDetail((current) => (current ? { ...current, skill } : current));
      setSaveState("saved");
    } catch (cause) {
      setDetail(previous);
      setSaveState("idle");
      toast.error(`Couldn’t save: ${message(cause)}`);
    }
  };

  const remove = async () => {
    try {
      await rpc.call("library_remove", { name });
      toast.success(`Removed ${name}`);
      nav.toLibrary();
    } catch (cause) {
      toast.error(message(cause));
    }
  };

  const back = (
    <Button variant="ghost" size="sm" onClick={nav.toLibrary} className="-ml-2 text-muted-foreground">
      <Icon name="ArrowLeft" className="size-4" />
      Scoped Skills
    </Button>
  );

  if (error !== null && detail === null) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-10 pt-3 md:px-5 md:pt-4">
          {back}
          <Notice>{error}</Notice>
        </div>
      </div>
    );
  }

  const scope = detail?.skill.scope;
  const agents = library?.agents ?? [];
  const pickingAgents = scope?.agents !== null && scope?.agents.length === 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-3 md:px-5 md:pt-4">
        {back}

        {detail === null || scope === undefined ? (
          <div className="mt-4 space-y-3" aria-label="Loading skill">
            <div className="h-5 w-48 animate-pulse rounded bg-state-hover" />
            <div className="h-3 w-72 animate-pulse rounded bg-state-hover" />
            <div className="h-40 animate-pulse rounded-lg bg-state-hover" />
          </div>
        ) : (
          <>
            <header className="mt-3 flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-semibold text-foreground">{detail.skill.name}</h1>
                <p className="mt-1 flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
                  {detail.skill.source ? (
                    <>
                      <span className="shrink-0">From</span>
                      <code title={detail.skill.source} className="min-w-0 truncate text-foreground/80">
                        {detail.skill.source}
                      </code>
                      <span className="shrink-0">·</span>
                    </>
                  ) : null}
                  <span className="shrink-0">
                    {plural(detail.skill.fileCount, "file")} · {formatBytes(detail.skill.totalBytes)}
                  </span>
                </p>
              </div>
              {confirmRemove ? (
                <div className="flex shrink-0 items-center gap-1">
                  <span className="mr-1 text-xs text-muted-foreground">Remove from the library?</span>
                  <Button variant="destructive" size="sm" onClick={remove}>
                    Remove
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmRemove(true)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Icon name="Trash2" className="size-4" />
                  Remove
                </Button>
              )}
            </header>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{detail.skill.description}</p>

            <section aria-labelledby="who-gets-it" className="mt-8">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 id="who-gets-it" className="text-sm font-medium text-foreground">
                  Who gets it
                </h2>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
                  {saveState === "saving" ? (
                    <>
                      <Icon name="Loading" className="size-3 animate-spin" />
                      Saving…
                    </>
                  ) : saveState === "saved" ? (
                    <>
                      <Icon name="Check" className="size-3 text-primary" />
                      Saved · applies to new threads
                    </>
                  ) : (
                    "Saves automatically · applies to new threads"
                  )}
                </span>
              </div>
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                <Field
                  label="Agents"
                  hint={pickingAgents ? <span className="text-amber-700 dark:text-amber-300">Pick at least one agent.</span> : null}
                >
                  <AgentPicker
                    agents={agents}
                    value={scope.agents}
                    onChange={(next) => {
                      if (next !== null && next.length === 0) {
                        setDetail({ ...detail, skill: { ...detail.skill, scope: { ...scope, agents: [] } } });
                        return;
                      }
                      void save({ ...scope, agents: next });
                    }}
                    disabled={saving}
                  />
                </Field>
                <Field label="Models" hint={scope.models === null ? "Any model. Use * as a wildcard." : null}>
                  <TokenInput
                    value={scope.models ?? []}
                    onChange={(next) => void save({ ...scope, models: next.length === 0 ? null : next })}
                    placeholder="Add a model, e.g. gpt-5* or claude-opus-*"
                    label={`Models for ${name}`}
                  />
                </Field>
                <Field label="Projects" hint={<ProjectReadout globs={scope.projects ?? []} projects={library?.projects ?? []} />}>
                  <TokenInput
                    value={scope.projects ?? []}
                    onChange={(next) => void save({ ...scope, projects: next.length === 0 ? null : next })}
                    placeholder="Add a project name or glob, e.g. *my-org/*"
                    label={`Projects for ${name}`}
                    suggestions={library?.projects.map((project) => project.name)}
                  />
                </Field>
              </div>
            </section>

            <section aria-labelledby="skill-md" className="mt-8">
              <h2 id="skill-md" className="mb-2 text-sm font-medium text-foreground">
                SKILL.md
              </h2>
              <div className="max-h-[36rem] overflow-y-auto rounded-lg border border-border bg-card px-5 py-4 text-sm">
                {detail.skillMd.trim() === "" ? (
                  <p className="text-muted-foreground">This skill has no SKILL.md body.</p>
                ) : (
                  <Markdown content={stripFrontmatter(detail.skillMd)} />
                )}
              </div>
            </section>

            {detail.files.length > 1 ? (
              <section aria-labelledby="skill-files" className="mt-8">
                <h2 id="skill-files" className="mb-2 text-sm font-medium text-foreground">
                  Files <span className="font-normal text-muted-foreground">{detail.files.length}</span>
                </h2>
                <ul className="divide-y divide-border rounded-lg border border-border bg-card text-xs">
                  {detail.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-3 px-4 py-2">
                      <Icon name="FileText" fallback="File" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">{file.path}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(file.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Panel ------------------------------------------------------------------

function ScopedSkillsPanel({ subPath }: { subPath: string }) {
  if (subPath.startsWith(SKILL_PREFIX)) {
    const name = decodeURIComponent(subPath.slice(SKILL_PREFIX.length).replace(/\/+$/, ""));
    if (name !== "") return <SkillView key={name} name={name} />;
  }
  return <LibraryView />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "library",
    title: "Scoped Skills",
    icon: "ListChecks",
    path: PANEL,
    component: ScopedSkillsPanel,
  });
});
