/**
 * What a running turn is doing, said in words.
 *
 * A turn is thinking, reading, writing, running something, or answering, and the
 * wait feels different in each case: a minute spent on a command is work, and a
 * minute spent on nothing is a stall. One label for all of them said "thinking" over
 * a shell command, which is both wrong and the least useful thing it could say.
 * See ADR-038.
 */

/**
 * Verbs by what the tool name says about it.
 *
 * Matched on the lowercased name, because the engines each name their tools
 * differently and none of them declares a verb: `Read`, `read`, `fs_read` and
 * `view_file` are one action under four names. Order is load-bearing, since the
 * names overlap: `TodoWrite` is not writing a file and `WebSearch` is searching
 * rather than fetching, so the narrower rule is asked first.
 */
const VERBS: readonly (readonly [RegExp, string])[] = [
  [/todo|plan/, 'planning'],
  [/task|agent|subagent/, 'delegating'],
  [/search|grep|glob|find/, 'searching'],
  [/read|view|cat|open/, 'reading'],
  [/edit|replace|patch|apply|insert/, 'editing'],
  [/write|create|save/, 'writing'],
  [/bash|shell|exec|run|command|terminal|process/, 'running'],
  [/delete|remove|\brm\b/, 'deleting'],
  [/move|rename/, 'moving'],
  [/list|\bls\b|dir|tree/, 'listing'],
  [/fetch|web|http|url|browse/, 'fetching'],
];

/**
 * The verb for one tool call.
 *
 * Falls back to working rather than to the tool's own name: a name the engine
 * invented reads as jargon in a sentence about waiting, and the activity above the
 * indicator already says exactly which tool it was.
 */
export function describeWork(tool: string): string {
  const name = tool.toLowerCase();

  for (const [pattern, verb] of VERBS) {
    if (pattern.test(name)) {
      return verb;
    }
  }

  return 'working';
}

/** The last thing a running turn reported, which is all that is known about it. */
export interface RunningItem {
  kind: 'text' | 'reasoning' | 'activity';
  /** Present on an activity, naming the tool as the engine named it. */
  tool?: string;
  /**
   * True when this is over rather than under way: a call that produced its output or
   * was refused, or text that has already been stored.
   *
   * Read because a finished item is not what the turn is doing any more. Without it
   * the line sat on "reading" for the whole minute the model spent deciding what to
   * do with what it had read, and said "answering" through the pause after a
   * paragraph was flushed to run a tool.
   */
  finished?: boolean;
}

/**
 * What to say while a turn is still running.
 *
 * Read from the last thing reported, because that is the last thing known: a tool
 * call is announced when it starts and its output arrives when it ends, so the call
 * at the end of the turn so far is the one still in progress. A turn that has
 * reported nothing yet is thinking, which is what every engine does first.
 */
export function describeTurn(last: RunningItem | undefined): string {
  // Nothing has been reported yet, or what was reported is finished and nothing has
  // replaced it. Either way the turn is between things, which is the model working
  // out what to do next.
  if (last === undefined || last.finished === true || last.kind === 'reasoning') {
    return 'thinking…';
  }

  if (last.kind === 'text') {
    return 'answering…';
  }

  return `${describeWork(last.tool ?? '')}…`;
}
