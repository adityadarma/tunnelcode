/**
 * Matching for permission rules.
 *
 * One syntax serves both directions, because both come from the same place: the
 * rules an engine suggests for a lasting grant are the same shape a ceiling is
 * written in. A rule is a tool name, optionally narrowed to what it acts on:
 * `Bash` or `Bash(curl *)`. See ADR-022.
 */

export interface PermissionRule {
  tool: string;
  /** Absent means the rule covers the tool whatever it acts on. */
  glob?: string;
}

/** Reads a rule, or undefined when the text is not one. */
export function parseRule(raw: string): PermissionRule | undefined {
  const text = raw.trim();

  if (text === '') {
    return undefined;
  }

  const narrowed = /^([^()]+)\((.*)\)$/.exec(text);

  if (narrowed === null) {
    // Parentheses that did not form a narrowing mean the rule is malformed. Read as
    // a tool name they would produce a rule that silently matches nothing.
    return /[()]/.test(text) ? undefined : { tool: text.toLowerCase() };
  }

  const tool = narrowed[1]?.trim().toLowerCase() ?? '';
  const glob = narrowed[2] ?? '';

  if (tool === '') {
    return undefined;
  }

  // An empty narrowing would match nothing at all, which is never what anyone
  // means by writing it.
  return glob.trim() === '' ? { tool } : { tool, glob };
}

export function parseRules(raw: readonly string[]): PermissionRule[] {
  return raw
    .map((entry) => parseRule(entry))
    .filter((rule): rule is PermissionRule => rule !== undefined);
}

/**
 * Turns a glob into a regular expression.
 *
 * Only `*` is a wildcard. Everything else is matched literally, so a rule
 * containing regular expression punctuation cannot quietly match more than it
 * looks like it does.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (character) =>
    character === '*' ? '\u0000' : `\\${character}`,
  );

  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

function toolMatches(rule: PermissionRule, tool: string): boolean {
  return rule.tool === tool.trim().toLowerCase();
}

function globMatches(rule: PermissionRule, operation: string): boolean {
  return rule.glob === undefined || globToRegExp(rule.glob).test(operation.trim());
}

/**
 * Operators that put more than one command inside a single operation.
 *
 * A shell command line is one operation as far as an engine reports it, but the
 * shell will happily run several commands from it. Matching the line as a whole
 * would let `curl example.com; rm -rf ~` pass a rule written for curl.
 *
 * One character class rather than a list of operators: `&&` and `||` need no
 * alternative of their own, because splitting on either character leaves an empty
 * segment that is dropped anyway. `&` on its own is what this used to miss, and it
 * was the worst one to miss: it backgrounds the first command and runs the second,
 * so a grant written for curl covered `curl example.com & rm -rf ~` in full, and a
 * ceiling written for `rm *` did not recognise it at all. A lone carriage return
 * starts a new command for the same reason a newline does.
 */
const COMMAND_SEPARATORS = /[;|&\n\r]/;

/**
 * Constructs that can hide a command inside another one.
 *
 * Unlike a separator these cannot be decomposed by splitting, so an operation
 * containing one is never treated as covered. Both process substitutions are
 * listed: `>(...)` runs a command just as `<(...)` does, and leaving it out let
 * `curl example.com > >(rm -rf ~)` pass as one curl call.
 */
const HIDDEN_COMMAND = /\$\(|`|<\(|>\(/;

/**
 * Text that opens or closes a command written inside another one.
 *
 * Only the ceiling splits on these. A grant is refused outright for anything
 * HIDDEN_COMMAND recognises, because there is no honest reading of the whole of
 * what such a line would run. The ceiling has the opposite job: it has to see the
 * `rm` in `echo hi > >(rm -rf ~)` in order to forbid it, and refusing to read the
 * line would mean the rule the user set in their own terminal simply does not
 * apply. Every substitution form ends in `(`, so the bracket alone reaches all of
 * them, along with a subshell and a brace group.
 */
const NESTED_COMMAND_BOUNDARY = /[`(){}]/;

function partsOf(text: string, separator: RegExp): string[] {
  return text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function segmentsOf(operation: string): string[] {
  return partsOf(operation, COMMAND_SEPARATORS);
}

/**
 * Every command an operation would run that a rule may be judged against,
 * including the ones written inside another command.
 *
 * The segments are kept alongside their inner parts rather than replaced by them,
 * so a rule describing the whole of `find . -exec rm {} \;` still reaches it.
 */
function reachableParts(operation: string): string[] {
  const parts = segmentsOf(operation).flatMap((segment) => [
    segment,
    ...partsOf(segment, NESTED_COMMAND_BOUNDARY),
  ]);

  return [...new Set(parts)];
}

/**
 * True when a rule reaches an operation, looking inside it as well as at it.
 *
 * Used for the ceiling, where matching more is the safe direction: splitting on a
 * separator inside a quoted string can over-match, and over-refusing is a nuisance
 * where under-refusing is a hole.
 */
function ruleReaches(rule: PermissionRule, operation: string): boolean {
  if (rule.glob === undefined) {
    return true;
  }

  return (
    globMatches(rule, operation) ||
    reachableParts(operation).some((part) => globMatches(rule, part))
  );
}

/**
 * True when narrowed rules account for everything one operation would run.
 *
 * Every command in the line has to be covered, not just the line as a whole. A
 * construct that could hide a command is never covered at all, because there is no
 * honest way to read what it would run.
 */
function coversOperation(rules: readonly PermissionRule[], operation: string): boolean {
  if (HIDDEN_COMMAND.test(operation)) {
    return false;
  }

  const segments = segmentsOf(operation);

  return (
    segments.length > 0 &&
    segments.every((segment) => rules.some((rule) => globMatches(rule, segment)))
  );
}

/**
 * True when any rule reaches this ask.
 *
 * Used for the ceiling, where reaching one operation is enough: an ask that would
 * run three commands and only one of them forbidden is still an ask this machine
 * must refuse.
 */
export function anyRuleMatches(
  rules: readonly PermissionRule[],
  tool: string,
  operations: readonly string[],
): PermissionRule | undefined {
  for (const rule of rules) {
    if (!toolMatches(rule, tool)) {
      continue;
    }

    if (rule.glob === undefined) {
      return rule;
    }

    if (operations.some((operation) => ruleReaches(rule, operation))) {
      return rule;
    }
  }

  return undefined;
}

/**
 * True when the rules cover everything this ask would do.
 *
 * Deliberately stricter than the ceiling check. A grant for `Bash(curl *)` must
 * not silently allow an ask that runs `curl` and then `rm -rf`, which is exactly
 * what matching on any single operation would do.
 */
export function rulesCoverAll(
  rules: readonly PermissionRule[],
  tool: string,
  operations: readonly string[],
): boolean {
  const forTool = rules.filter((rule) => toolMatches(rule, tool));

  if (forTool.length === 0) {
    return false;
  }

  // A rule naming the tool without narrowing it is the whole decision, whatever
  // the ask would do.
  if (forTool.some((rule) => rule.glob === undefined)) {
    return true;
  }

  // Nothing said about what the ask would do, and every rule here describes what
  // it may act on. Treating that as covered turned a grant for one command into a
  // grant for the tool, so it is refused and the user is asked instead.
  if (operations.length === 0) {
    return false;
  }

  return operations.every((operation) => coversOperation(forTool, operation));
}

/**
 * Everything an ask would actually do, as one list.
 *
 * The target and the details overlap by design: one engine reports a single call,
 * the other reports several operations under one ask, and a grant has to be judged
 * against all of them.
 */
export function operationsOf(ask: {
  target?: string | undefined;
  details: readonly string[];
}): string[] {
  const operations = [...(ask.target !== undefined ? [ask.target] : []), ...ask.details];
  return [...new Set(operations.filter((operation) => operation.trim() !== ''))];
}
