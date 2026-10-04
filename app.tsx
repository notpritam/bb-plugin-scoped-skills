// Scoped Skills — the library page.
//
// One page: a preview of what a thread on a given agent/model receives, the
// library with per-skill agent toggles and model globs, and an import form.
// All state lives on the server; the page refetches on "library-changed".
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Agent, rpcContract, SkillSummary } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function useLibrary() {
  const rpc = useRpc<typeof rpcContract>();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("library_list").then((result) => {
      setSkills(result.skills);
      setAgents(result.agents);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("library-changed", refetch);
  return { rpc, skills, agents, error, report, setError, refetch };
}

const splitGlobs = (text: string) =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A row of toggle chips: "All agents" plus one per agent BB knows. */
function AgentChips({
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
  const chip = (active: boolean) =>
    cn(
      "rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
    );
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Agents">
      <button type="button" disabled={disabled} className={chip(value === null)} aria-pressed={value === null} onClick={() => onChange(null)}>
        All agents
      </button>
      {agents.map((agent) => {
        const active = value !== null && value.includes(agent.id);
        return (
          <button
            key={agent.id}
            type="button"
            disabled={disabled}
            className={chip(active)}
            aria-pressed={active}
            onClick={() => {
              const current = value ?? [];
              const next = active ? current.filter((id) => id !== agent.id) : [...current, agent.id];
              onChange(next.length === 0 ? null : next);
            }}
          >
            {agent.name}
          </button>
        );
      })}
    </div>
  );
}

function SkillCard({
  skill,
  agents,
  included,
  onScope,
  onRemove,
}: {
  skill: SkillSummary;
  agents: Agent[];
  included: boolean;
  onScope: (agents: string[] | null, models: string[] | null) => Promise<void>;
  onRemove: () => void;
}) {
  const [models, setModels] = useState(skill.scope.models?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setModels(skill.scope.models?.join(", ") ?? ""), [skill.scope.models]);
  const save = async (nextAgents: string[] | null, nextModels: string[] | null) => {
    setBusy(true);
    try {
      await onScope(nextAgents, nextModels);
    } finally {
      setBusy(false);
    }
  };
  const savedModels = skill.scope.models?.join(", ") ?? "";
  return (
    <li className={cn("space-y-3 px-4 py-3.5", !included && "bg-muted/40")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{skill.name}</span>
            <span
              className={cn(
                "rounded px-1.5 py-px text-[11px]",
                included ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              {included ? "included" : "withheld"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="destructive" size="sm" onClick={onRemove}>
              Remove
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${skill.name}`}
            onClick={() => setConfirming(true)}
          >
            <Icon name="Trash2" className="size-4" />
          </Button>
        )}
      </div>
      <AgentChips agents={agents} value={skill.scope.agents} disabled={busy} onChange={(next) => save(next, skill.scope.models)} />
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = splitGlobs(models);
          void save(skill.scope.agents, next.length === 0 ? null : next);
        }}
      >
        <Input
          value={models}
          onChange={(event) => setModels(event.target.value)}
          placeholder="Any model — or globs like gpt-5*, claude-opus-*"
          aria-label={`Models for ${skill.name}`}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || models.trim() === savedModels}>
          Save
        </Button>
      </form>
      <p className="text-[11px] text-muted-foreground">
        {skill.fileCount} files · {formatBytes(skill.totalBytes)}
        {skill.source ? ` · from ${skill.source}` : ""}
      </p>
    </li>
  );
}

function Section({ title, children, hint }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function ScopedSkillsPage() {
  const { rpc, skills, agents, error, report, setError, refetch } = useLibrary();
  const [previewAgent, setPreviewAgent] = useState<string | null>(null);
  const [previewModel, setPreviewModel] = useState("");
  const [included, setIncluded] = useState<Set<string> | null>(null);
  const [importPath, setImportPath] = useState("");
  const [importAgents, setImportAgents] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);

  const agentId = previewAgent ?? agents[0]?.id ?? null;
  useEffect(() => {
    if (agentId === null) return;
    rpc.call("library_preview", { agent: agentId, model: previewModel.trim() }).then(
      (result) => setIncluded(new Set(result.included)),
      report,
    );
  }, [rpc, report, agentId, previewModel, skills]);

  const agentName = useMemo(() => agents.find((agent) => agent.id === agentId)?.name ?? agentId, [agents, agentId]);

  const setScope = async (name: string, nextAgents: string[] | null, nextModels: string[] | null) => {
    try {
      await rpc.call("library_set_scope", { name, agents: nextAgents, models: nextModels });
      refetch();
    } catch (cause) {
      report(cause);
    }
  };

  const importSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (importPath.trim() === "" || importing) return;
    setImporting(true);
    setError(null);
    try {
      await rpc.call("library_import", { path: importPath.trim(), agents: importAgents, models: null, replace: false });
      setImportPath("");
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setImporting(false);
    }
  };

  const includedCount = skills?.filter((skill) => included?.has(skill.name)).length ?? 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Skills here reach only the agents you pick. Anything in <code>~/.bb/skills</code> still reaches every agent,
          so keep a scoped skill out of there.
        </p>

        {error === null ? null : (
          <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Section
          title="Preview a thread"
          hint={skills === null || agentId === null ? null : `${agentName} gets ${includedCount} of ${skills.length}`}
        >
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Preview agent">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="radio"
                  aria-checked={agent.id === agentId}
                  onClick={() => setPreviewAgent(agent.id)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    agent.id === agentId
                      ? "border-foreground/60 bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {agent.name}
                </button>
              ))}
            </div>
            <Input
              value={previewModel}
              onChange={(event) => setPreviewModel(event.target.value)}
              placeholder="Model (optional), e.g. gpt-5.5 or claude-opus-5-5"
              aria-label="Preview model"
              className="h-8 text-xs"
            />
          </div>
        </Section>

        <Section title="Library" hint={skills === null ? null : `${skills.length} skills`}>
          {skills === null ? (
            <EmptyState>Loading…</EmptyState>
          ) : skills.length === 0 ? (
            <EmptyState>
              No scoped skills yet. Import a skill folder below, or run{" "}
              <code>bb scoped-skills import ~/.claude/skills/&lt;name&gt; --agents codex</code>.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  agents={agents}
                  included={included?.has(skill.name) ?? true}
                  onScope={(nextAgents, nextModels) => setScope(skill.name, nextAgents, nextModels)}
                  onRemove={() => {
                    rpc.call("library_remove", { name: skill.name }).then(refetch, report);
                  }}
                />
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Changes apply to new sessions. Running threads keep their skills until restarted.</p>
        </Section>

        <Section title="Import a skill folder">
          <form onSubmit={importSkill} className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <Input
                value={importPath}
                onChange={(event) => setImportPath(event.target.value)}
                placeholder="~/.claude/skills/brandkit"
                aria-label="Skill folder path on the BB server"
                className="font-mono text-xs"
              />
              <Button type="submit" disabled={importing || importPath.trim() === ""}>
                <Icon name="Plus" className="size-4" />
                Import
              </Button>
            </div>
            <AgentChips agents={agents} value={importAgents} onChange={setImportAgents} disabled={importing} />
            <p className="text-[11px] text-muted-foreground">
              Copies the folder (it must contain SKILL.md). The original stays where it is; delete it once you've checked
              the import, or it will still reach every agent.
            </p>
          </form>
        </Section>
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "library",
    title: "Scoped Skills",
    icon: "ListChecks",
    path: "library",
    component: ScopedSkillsPage,
  });
});
