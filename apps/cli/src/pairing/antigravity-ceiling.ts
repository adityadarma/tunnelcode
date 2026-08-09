import { loadGlobalConfig } from '@tunnelcode/config';
import { anyRuleMatches, parseRule, parseRules } from './permission-rules.js';

/**
 * Whether `Never allow` forbids a rule about to be written to Antigravity's own
 * settings.
 *
 * Antigravity raises no permission ask, so `createPermissionPolicy` never sees one
 * for it and the ceiling it checks first has nothing to check. The decision is
 * already finished inside `agy`'s settings file before the turn starts. That left
 * `permission.deny` with no point of entry at all for this engine: a user who had
 * written `write_file(*)` under `Never allow` could still grant write access from
 * the menu and watch files change.
 *
 * So the ceiling is applied where the grant is made instead of where an ask is
 * answered. Same rules, same matching, just an earlier moment. See ADR-022, ADR-031,
 * ADR-035.
 */
export interface CeilingRefusal {
  /** The Antigravity rule that was refused, as it would have been written. */
  rule: string;
  /** The `Never allow` entry that forbids it, worded for a person. */
  denied: string;
}

/**
 * The `Never allow` entry forbidding this rule, or undefined when none does.
 *
 * The rule is read with the same parser the ceiling uses, so `write_file(/path)` is
 * judged as the tool `write_file` acting on `/path`, exactly as an ask would have
 * been. A rule that cannot be parsed is treated as forbidden by nothing, because
 * refusing on a rule this project itself constructed would only ever be a bug
 * reported as a policy.
 */
export async function ceilingRefusing(rule: string): Promise<CeilingRefusal | undefined> {
  const parsed = parseRule(rule);

  if (parsed === undefined) {
    return undefined;
  }

  const config = await loadGlobalConfig();
  const ceiling = parseRules(config?.permission.deny ?? []);
  const operations = parsed.glob === undefined ? [] : [parsed.glob];

  // Both directions, because a grant is a rule rather than a call and can be the
  // wider of the two. `command(*)` covers every command, so `Never allow` set to
  // `command(rm *)` forbids granting it even though the text `rm *` does not appear
  // in `*`. Only asking whether the ceiling reaches the grant would miss exactly the
  // case ADR-035 warns about, where one grant is wider than the work in front of it.
  const denied =
    anyRuleMatches(ceiling, parsed.tool, operations) ??
    ceiling.find(
      (rule) =>
        rule.glob !== undefined && anyRuleMatches([parsed], rule.tool, [rule.glob]) !== undefined,
    );

  if (denied === undefined) {
    return undefined;
  }

  return {
    rule,
    denied: `${denied.tool}${denied.glob === undefined ? '' : `(${denied.glob})`}`,
  };
}
