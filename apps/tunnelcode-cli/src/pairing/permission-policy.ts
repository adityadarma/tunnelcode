import { addGrants, loadGlobalConfig, loadGrants } from '@tunnelcode/config';
import type { EnginePermissionDecision, EnginePermissionRequest } from '@tunnelcode/engine';
import { anyRuleMatches, operationsOf, parseRules, rulesCoverAll } from './permission-rules.js';

/** An answer reached without troubling anyone, and why. */
export interface SettledPermission {
  decision: EnginePermissionDecision;
  reason: string;
}

/**
 * Decides what this machine already knows about an ask.
 *
 * Consulted before the browser is, so a rule the user granted earlier is not
 * asked about again and a rule the ceiling forbids is never offered as a choice.
 * See ADR-022.
 */
export interface PermissionPolicy {
  /** An answer that needs no one, or undefined when the user has to decide. */
  settle: (ask: EnginePermissionRequest) => Promise<SettledPermission | undefined>;
  /** Records a lasting grant, returning the rules that were actually new. */
  grant: (ask: EnginePermissionRequest) => Promise<string[]>;
}

/**
 * What a lasting grant should record for an ask.
 *
 * The engine's own suggestions are preferred, because they are worded to match
 * calls like this one rather than only this exact call. With none offered, the
 * operations are recorded literally: a rule with no wildcard covers only what was
 * actually agreed to, which is the safe way to be wrong.
 */
export function rulesToGrant(ask: EnginePermissionRequest): string[] {
  if (ask.suggestions.length > 0) {
    return [...new Set(ask.suggestions.filter((suggestion) => suggestion.trim() !== ''))];
  }

  const operations = operationsOf(ask);

  return operations.length === 0
    ? [ask.tool]
    : operations.map((operation) => `${ask.tool}(${operation})`);
}

/**
 * Policy backed by this machine's configuration and stored grants.
 *
 * Both files are read per ask rather than cached, so a ceiling tightened in the
 * terminal takes effect on the next ask instead of at the next restart, and a
 * grant made a moment ago is already in force.
 */
export function createPermissionPolicy(): PermissionPolicy {
  return {
    settle: async (ask) => {
      const operations = operationsOf(ask);

      // The ceiling is checked first, so a granted rule can never reach past it.
      // A grant is a tap on a phone; the ceiling is answered in a terminal on this
      // machine, and the second has to win.
      const config = await loadGlobalConfig();
      const denied = anyRuleMatches(
        parseRules(config?.permission.deny ?? []),
        ask.tool,
        operations,
      );

      if (denied !== undefined) {
        return {
          decision: 'reject',
          reason: `Not allowed on this machine: ${denied.tool}${denied.glob === undefined ? '' : `(${denied.glob})`}.`,
        };
      }

      const grants = await loadGrants();

      if (rulesCoverAll(parseRules(grants.map((entry) => entry.rule)), ask.tool, operations)) {
        return { decision: 'once', reason: 'Allowed by a rule granted on this machine.' };
      }

      return undefined;
    },

    grant: async (ask) => addGrants(rulesToGrant(ask)),
  };
}
