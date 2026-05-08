#!/usr/bin/env node
/**
 * Sync auto-approval lists across IDE configs from the generated _registry.ts.
 *
 * Each IDE has its own auto-approval mechanism:
 *   - Claude Code: `.claude/settings.json` → permissions.allow with `mcp__figcraft__<tool>` format.
 *     Claude Code does NOT honor `autoApprove` inside `.mcp.json` — that field is silently
 *     ignored. Auto-approval is only configurable through `.claude/settings.json`.
 *   - Kiro: `.kiro/settings/mcp.json` → mcpServers.figcraft.autoApprove with plain tool names.
 *   - Cursor: `.cursor/mcp.json` does not have an autoApprove field — Cursor's approval flow
 *     prompts per tool. Left untouched.
 *
 * This script also strips any stale `autoApprove` field from `.mcp.json/figcraft` (dead config
 * for Claude Code) so contributors don't get misled.
 *
 * Tool list source: GENERATED_CORE_TOOLS / GENERATED_BRIDGE_TOOLS / GENERATED_CUSTOM_TOOLS /
 * GENERATED_ENDPOINT_TOOLS in `packages/core-mcp/src/tools/_registry.ts`, plus three meta tools
 * (`load_toolset`, `unload_toolset`, `list_toolsets`).
 *
 * Usage: node scripts/sync-auto-approve.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const registryPath = resolve(root, 'packages/core-mcp/src/tools/_registry.ts');
const claudeSettingsPath = resolve(root, '.claude/settings.json');
const kiroConfigPath = resolve(root, '.kiro/settings/mcp.json');
const mcpConfigPath = resolve(root, '.mcp.json');

const SERVER_NAME = 'figcraft';
const META_TOOLS = ['load_toolset', 'unload_toolset', 'list_toolsets'];

/**
 * Extract a Set's literal entries from `_registry.ts`.
 * Bracket-balanced so trailing arrays after the Set don't pollute the match.
 */
function extractSet(registry, setName) {
  const start = registry.indexOf(setName);
  if (start === -1) return [];
  const openBracket = registry.indexOf('[', start);
  if (openBracket === -1) return [];
  let depth = 1;
  let i = openBracket + 1;
  while (i < registry.length && depth > 0) {
    const ch = registry[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    i++;
  }
  const body = registry.slice(openBracket + 1, i - 1);
  return [...body.matchAll(/'([a-z][a-z0-9_]+)'/g)].map((m) => m[1]);
}

const registry = readFileSync(registryPath, 'utf8');
const tools = new Set();
for (const setName of [
  'GENERATED_CORE_TOOLS',
  'GENERATED_BRIDGE_TOOLS',
  'GENERATED_CUSTOM_TOOLS',
  'GENERATED_ENDPOINT_TOOLS',
]) {
  for (const tool of extractSet(registry, setName)) tools.add(tool);
}
for (const meta of META_TOOLS) tools.add(meta);

const sortedTools = [...tools].sort();
console.log(`📦 Discovered ${sortedTools.length} MCP tools from _registry.ts`);

let touched = 0;

// ── 1. Claude Code: .claude/settings.json → permissions.allow with mcp__figcraft__ prefix ──
if (existsSync(claudeSettingsPath)) {
  const raw = readFileSync(claudeSettingsPath, 'utf8');
  const settings = JSON.parse(raw);
  settings.permissions ??= {};
  const allow = settings.permissions.allow ?? [];
  const otherEntries = allow.filter((entry) => !entry.startsWith(`mcp__${SERVER_NAME}__`));
  const figcraftEntries = sortedTools.map((t) => `mcp__${SERVER_NAME}__${t}`);
  settings.permissions.allow = [...otherEntries, ...figcraftEntries].sort();
  const next = `${JSON.stringify(settings, null, 2)}\n`;
  if (next !== raw) {
    writeFileSync(claudeSettingsPath, next);
    console.log(`✅ .claude/settings.json: ${figcraftEntries.length} mcp__${SERVER_NAME}__* entries`);
    touched++;
  } else {
    console.log('✓  .claude/settings.json: already in sync');
  }
} else {
  console.log('⏭️  .claude/settings.json not found — skipping');
}

// ── 2. Kiro: .kiro/settings/mcp.json → mcpServers.figcraft.autoApprove ──
if (existsSync(kiroConfigPath)) {
  const raw = readFileSync(kiroConfigPath, 'utf8');
  const config = JSON.parse(raw);
  const server = config.mcpServers?.[SERVER_NAME];
  if (!server) {
    console.error(`❌ ${SERVER_NAME} server not found in .kiro/settings/mcp.json`);
    process.exit(1);
  }
  server.autoApprove = sortedTools;
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (next !== raw) {
    writeFileSync(kiroConfigPath, next);
    console.log(`✅ .kiro/settings/mcp.json: ${sortedTools.length} autoApprove entries`);
    touched++;
  } else {
    console.log('✓  .kiro/settings/mcp.json: already in sync');
  }
} else {
  console.log('⏭️  .kiro/settings/mcp.json not found — skipping');
}

// ── 3. .mcp.json: strip dead autoApprove on figcraft (Claude Code ignores it) ──
if (existsSync(mcpConfigPath)) {
  const raw = readFileSync(mcpConfigPath, 'utf8');
  const config = JSON.parse(raw);
  const server = config.mcpServers?.[SERVER_NAME];
  if (server && 'autoApprove' in server) {
    delete server.autoApprove;
    const next = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(mcpConfigPath, next);
    console.log('🧹 .mcp.json: removed dead autoApprove field (Claude Code uses .claude/settings.json)');
    touched++;
  } else {
    console.log('✓  .mcp.json: clean (no dead autoApprove field)');
  }
}

if (touched === 0) console.log('\n✨ All IDE configs already in sync.');
