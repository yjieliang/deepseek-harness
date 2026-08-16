# Agent Note: Global knowledge-base root

Status: implemented

English | [中文](2026-08-16-global-knowledge-base.zh.md)

## Problem

The knowledge base was scoped to the current workspace (`<workspace>/kb`), so a person's notes were invisible from any other project on the same machine. A personal knowledge library is machine-wide by intent, not per-repository; the per-workspace shape also split the library across every cloned checkout.

## Decision

The library root is now machine-global: `@deepseek-ai/dsh-host-kb` gains a `root` config (default `$DSH_HOME/kb`, an absolute path or one relative to the harness home), and the engine resolves every library-relative path directly under that root instead of under the session workspace. Because the root lives outside any workspace, the sandbox seam gains a deployment-declared allowance: `SandboxExecutionPolicy.writableRoots` admits extra canonical roots under `workspace-write` (never under `read-only` or `danger-full-access`), and the web-app bundle sets it to `$DSH_HOME/kb` beside the `kb` row's `root`. The two must move together when a deployment relocates the library.

## Alternatives considered

### Why not a two-layer library (workspace + global)?

Layering would mirror the habits L1/L2 split, but the person asked for one shared library and the tool/panel vocabulary has no layer concept yet; a second layer would be speculative surface. The single global root satisfies the request with the least new vocabulary.

### Why not keep the root a workspace-relative config value?

A configurable root that defaults to the workspace keeps backward compatibility, but the person explicitly chose global-only, and a per-workspace default would leave the same fragmentation the change removes.

### Why not let the kb engine bypass the sandbox?

The engine writes through the sandboxed `fs` service; bypassing it would exempt one model-writable path from the shared file policy. Admitting the library root through `writableRoots` keeps every write on the sandboxed seam while making "extra controlled write zones" a first-class, reusable policy concept.

## Consequences

- The library is shared by every workspace on a host; a fresh machine has an empty library the engine materializes on first use.
- Existing workspace libraries do not move automatically — migration is the operator's one-time copy.
- `writableRoots` is a general sandbox capability, not a kb-specific carve-out; future machine-global stores reuse it.
- `read-only` and `danger-full-access` are unchanged by the new field.

## Testing

`sandbox` roots and `sandbox-policy` resolve tests cover the additional-root derivation and carry-through; `fs-sandbox` exercises it through the shared allow-list; `host-kb` engine and tool suites run against a temp absolute root. Windows ACL runner integration tests remain host-environment-gated.
