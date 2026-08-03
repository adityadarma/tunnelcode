import type { Activity, Message, Reasoning } from '../api.js';
import type { RunningItem } from './turn-status.js';

/**
 * One thing an assistant turn produced: a paragraph, a stretch of thinking, or a
 * tool call.
 */
export type AssistantItem =
  | { kind: 'text'; id: string; content: string; at: number; partial?: boolean; live?: boolean }
  | { kind: 'activity'; id: string; activity: Activity; at: number }
  | { kind: 'reasoning'; id: string; content: string; at: number; live?: boolean };

interface UserTurn {
  kind: 'user';
  id: string;
  message: Message;
}

interface AssistantTurn {
  kind: 'assistant';
  id: string;
  createdAt: number;
  items: AssistantItem[];
  isStreaming?: boolean;
}

export type Turn = UserTurn | AssistantTurn;

/**
 * Groups user messages, assistant messages, thinking and activities into ordered
 * turns.
 *
 * Everything is placed by the time it happened, so a thought sits before the tool
 * call it led to and the answer that followed reads in the order it arrived.
 * See ADR-024.
 */
export function buildTurns(
  messages: Message[],
  activities: Activity[],
  reasonings: Reasoning[],
  streaming: string | undefined,
  reasoningStream: string | undefined,
): Turn[] {
  type RawEntry =
    | { kind: 'user-msg'; at: number; message: Message }
    | { kind: 'assistant-msg'; at: number; message: Message }
    | { kind: 'activity'; at: number; activity: Activity }
    | { kind: 'reasoning'; at: number; reasoning: Reasoning };

  const rawEntries: RawEntry[] = [
    // Thinking comes first in the unsorted list, because the sort is stable and a
    // thought is stored in the same millisecond as whatever closed it off. A model
    // thinks before it speaks, so a tie belongs to the thought.
    ...reasonings.map((r): RawEntry => ({ kind: 'reasoning', at: r.createdAt, reasoning: r })),
    ...messages.map((m): RawEntry => ({
      kind: m.role === 'user' ? 'user-msg' : 'assistant-msg',
      at: m.createdAt,
      message: m,
    })),
    ...activities.map((a): RawEntry => ({
      kind: 'activity',
      at: a.createdAt,
      activity: a,
    })),
  ].sort((left, right) => {
    if (left.at !== right.at) {
      return left.at - right.at;
    }
    if (left.kind === right.kind) {
      return 0;
    }
    return left.kind === 'user-msg' ? -1 : right.kind === 'user-msg' ? 1 : 0;
  });

  const turns: Turn[] = [];

  for (const entry of rawEntries) {
    if (entry.kind === 'user-msg') {
      turns.push({
        kind: 'user',
        id: entry.message.id,
        message: entry.message,
      });
      continue;
    }

    const item: AssistantItem =
      entry.kind === 'assistant-msg'
        ? {
            kind: 'text',
            id: entry.message.id,
            content: entry.message.content,
            at: entry.at,
            ...(entry.message.partial === true ? { partial: true } : {}),
          }
        : entry.kind === 'reasoning'
          ? {
              kind: 'reasoning',
              id: entry.reasoning.id,
              content: entry.reasoning.content,
              at: entry.at,
            }
          : { kind: 'activity', id: entry.activity.id, activity: entry.activity, at: entry.at };

    const lastTurn = turns[turns.length - 1];
    if (lastTurn !== undefined && lastTurn.kind === 'assistant') {
      lastTurn.items.push(item);
    } else {
      turns.push({
        kind: 'assistant',
        id: `assistant-turn-${item.id}`,
        createdAt: entry.at,
        items: [item],
      });
    }
  }

  const pending: AssistantItem[] = [];

  if (reasoningStream !== undefined && reasoningStream !== '') {
    pending.push({
      kind: 'reasoning',
      id: 'streaming-reasoning',
      content: reasoningStream,
      at: Date.now(),
      live: true,
    });
  }

  if (streaming !== undefined && streaming !== '') {
    pending.push({
      kind: 'text',
      id: 'streaming-text',
      content: streaming,
      at: Date.now(),
      // Marked so the status line can tell text that is arriving from a paragraph
      // the turn already stored on its way to running a tool.
      live: true,
    });
  }

  if (streaming !== undefined || pending.length > 0) {
    const lastTurn = turns[turns.length - 1];
    if (lastTurn !== undefined && lastTurn.kind === 'assistant') {
      lastTurn.isStreaming = true;
      lastTurn.items.push(...pending);
    } else {
      turns.push({
        kind: 'assistant',
        id: 'streaming-turn',
        createdAt: Date.now(),
        isStreaming: true,
        items: pending,
      });
    }
  }

  // Sorted within the turn as well, because the server splits the answer into
  // separate messages around tool calls, and placing everything by time is what
  // interleaves the three kinds correctly.
  for (const turn of turns) {
    if (turn.kind === 'assistant') {
      turn.items.sort((a, b) => a.at - b.at);
    }
  }

  return turns;
}

/** The last thing a turn reported, in the shape the status line reads. */
export function lastOf(items: AssistantItem[]): RunningItem | undefined {
  const last = items[items.length - 1];

  if (last === undefined) {
    return undefined;
  }

  if (last.kind === 'text') {
    // A stored paragraph is over. Only text still streaming means the turn is
    // answering right now.
    return { kind: 'text', ...(last.live === true ? {} : { finished: true }) };
  }

  if (last.kind === 'reasoning') {
    return { kind: 'reasoning' };
  }

  // Output or a refusal means the call is over, and the engine is deciding again.
  const finished =
    last.activity.blocked === true ||
    (typeof last.activity.output === 'string' && last.activity.output !== '');

  return {
    kind: 'activity',
    tool: last.activity.tool,
    ...(finished ? { finished: true } : {}),
  };
}
