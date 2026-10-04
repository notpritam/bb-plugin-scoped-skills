---
name: scoped-skills
description: Manage skills that only some agents receive through the Scoped Skills plugin. Use when the user asks which skills an agent (Claude Code, Codex, Cursor…) gets, wants a skill limited to one agent or model, wants to convert a Claude-only or Codex-only skill into a BB skill, or asks why a skill is missing in this thread.
---

# Scoped Skills

BB gives every skill in `~/.bb/skills` to every thread. Scoped Skills keeps a
separate library in which each skill carries a **scope**: which agents receive
it, and optionally which models. A thread only gets the scoped skills that
match its agent and model. Example: image-generation skills go only to Codex,
because Claude Code has no image tool.

## Tools

- `scoped_skills_list` shows every scoped skill, who receives it, and which
  agent this thread runs on. Call it first when a skill seems missing.
- `scoped_skills_set_scope` changes a skill's agents (and optional model
  globs). Only call it when the user asks.
- `scoped_skills_import` copies a skill folder (one containing `SKILL.md`)
  into the library with a scope. The original folder is left alone, so tell
  the user they can delete it once they've confirmed the import.

## CLI

```sh
bb scoped-skills agents                                   # ids you can scope to
bb scoped-skills list
bb scoped-skills import ~/.claude/skills/brandkit --agents codex
bb scoped-skills scope brandkit --agents codex,claude-code --models 'gpt-5*'
bb scoped-skills preview --agent claude-code --model claude-opus-5-5
bb scoped-skills remove brandkit
```

Lists are comma-separated, and `all` means no restriction. Model globs are
case-insensitive and use `*`.

## Rules

- A scope change applies to **new sessions**. A running thread keeps the
  skills it started with until its session restarts.
- Agent ids must be ones BB knows (`bb scoped-skills agents`). Unknown ids are
  rejected so a typo can't silently hide a skill.
- Import rejects a `SKILL.md` whose frontmatter isn't strict YAML. The usual
  culprit is an unquoted `: ` inside the description. Fix it with quotes or
  `description: >-`, then import again.
- Don't keep a second copy of the same skill in `~/.bb/skills`, `~/.claude/skills`
  or `~/.codex/skills`. Those reach every thread and defeat the scope.
