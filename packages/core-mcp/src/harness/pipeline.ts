/**
 * Harness Pipeline — middleware system for MCP tool execution.
 *
 * Runs registered rules in 6 phases around bridge.request():
 *   Phase 1: pre-guard      → block invalid calls
 *   Phase 2: pre-transform  → enrich/correct params
 *   Phase 3: execute        → bridge.request() (caller-provided)
 *   Phase 4: post-enrich    → inject quality/warnings/hints
 *   Phase 5: error-recovery → classify errors + suggest fixes
 *   Phase 6: session-update → record outcome for cross-turn learning
 *
 * Rules are matched by tool name patterns (exact, glob, '*') and
 * executed in priority order (lower number = earlier).
 */

import type { DesignSession } from '../design-session.js';
import type { HarnessContext, HarnessPhase, HarnessRequestMeta, HarnessRule } from './types.js';

export class HarnessPipeline {
  private readonly rules: HarnessRule[] = [];

  /** Register one or more rules. Re-sorts by priority after each registration. */
  register(...rules: HarnessRule[]): void {
    this.rules.push(...rules);
    this.rules.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /** Number of registered rules (for diagnostics). */
  get ruleCount(): number {
    return this.rules.length;
  }

  // ─── Core execution ───

  /**
   * Run the pipeline around a bridge request.
   *
   * @param ctx - Execution context (toolName, params, session, meta)
   * @param execute - The actual bridge.request() call (Phase 3)
   * @returns The (possibly enriched) result from execute()
   */
  async run(ctx: HarnessContext, execute: () => Promise<unknown>): Promise<unknown> {
    // Phase 1: Pre-guards — block invalid calls
    for (const rule of this.match(ctx.toolName, 'pre-guard')) {
      const action = await rule.execute(ctx);
      if (action.type === 'block') {
        const hint = action.hint ? `\n_hint: ${action.hint}` : '';
        throw new Error(`[Harness:${rule.name}] ${action.message}${hint}`);
      }
    }

    // Phase 2: Pre-transforms — modify params before execution
    for (const rule of this.match(ctx.toolName, 'pre-transform')) {
      const action = await rule.execute(ctx);
      if (action.type === 'transform') {
        ctx.params = action.params;
      }
    }

    // Phase 3: Execute — the actual bridge.request()
    try {
      ctx.result = await execute();
    } catch (err) {
      ctx.error = err instanceof Error ? err : new Error(String(err));

      // Phase 5: Error recovery — classify and suggest fixes
      const recoveries: string[] = [];
      for (const rule of this.match(ctx.toolName, 'error-recovery')) {
        try {
          const action = await rule.execute(ctx);
          if (action.type === 'recover') {
            recoveries.push(JSON.stringify(action.recovery));
          }
        } catch {
          /* recovery rules must not throw */
        }
      }

      // Re-throw with recovery suggestions appended
      if (recoveries.length > 0) {
        const enriched = new Error(`${ctx.error.message}\n_recovery: ${recoveries.join('\n_recovery: ')}`);
        enriched.stack = ctx.error.stack;
        throw enriched;
      }
      throw ctx.error;
    }

    // Phase 4: Post-enrich — inject quality/warnings/hints into response
    if (ctx.result && typeof ctx.result === 'object') {
      const r = ctx.result as Record<string, unknown>;
      for (const rule of this.match(ctx.toolName, 'post-enrich')) {
        try {
          const action = await rule.execute(ctx);
          if (action.type === 'enrich') {
            Object.assign(r, action.fields);
          } else if (action.type === 'warn') {
            const existing = Array.isArray(r._warnings) ? (r._warnings as string[]) : [];
            r._warnings = [...existing, ...action.warnings];
          }
        } catch {
          /* post-enrich rules are best-effort */
        }
      }
    }

    // Phase 6: Session update — record outcome for cross-turn learning
    for (const rule of this.match(ctx.toolName, 'session-update')) {
      try {
        await rule.execute(ctx);
      } catch {
        /* session-update rules are best-effort */
      }
    }

    return ctx.result;
  }

  // ─── Rule matching ───

  /** Get all rules matching a tool name and phase, sorted by priority. */
  private match(toolName: string, phase: HarnessPhase): HarnessRule[] {
    return this.rules.filter(
      (r) => r.phase === phase && r.tools.some((pattern) => matchToolPattern(pattern, toolName)),
    );
  }
}

// ─── Context factory ───

/** Create a HarnessContext from request parameters. */
export function createHarnessContext(
  toolName: string,
  bridgeMethod: string,
  params: Record<string, unknown>,
  session: DesignSession,
  isWrite: boolean,
): HarnessContext {
  const meta: HarnessRequestMeta = {
    isWrite,
    isDryRun: params.dryRun === true,
    isRootLevel: params.parentId == null,
    isBatch: Array.isArray(params.items),
  };

  return {
    toolName,
    bridgeMethod,
    params,
    session,
    meta,
    ruleState: {},
  };
}

// ─── Pattern matching ───

/** Match a tool name against a pattern (exact, glob suffix, or wildcard). */
function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) return true;
  return false;
}
