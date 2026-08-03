import { describe, expect, test } from 'vitest';
import { describeTurn, describeWork } from './turn-status.js';

describe('describeWork', () => {
  test('reads one action under the names four engines give it', () => {
    // Claude, opencode, Kiro and Antigravity each name the same action differently,
    // and none of them declares a verb. See ADR-038.
    for (const tool of ['Read', 'read', 'fs_read', 'view_file']) {
      expect(describeWork(tool)).toBe('reading');
    }

    for (const tool of ['Write', 'write', 'fs_write', 'write_to_file']) {
      expect(describeWork(tool)).toBe('writing');
    }

    for (const tool of ['Bash', 'bash', 'shell', 'execute', 'run_command']) {
      expect(describeWork(tool)).toBe('running');
    }

    for (const tool of ['Grep', 'Glob', 'grep_search', 'codebase_search']) {
      expect(describeWork(tool)).toBe('searching');
    }
  });

  test('a name that overlaps another is read by the narrower rule', () => {
    // TodoWrite writes no file, and WebSearch searches rather than fetches. Both
    // would be read wrongly by the broader rule if order stopped mattering.
    expect(describeWork('TodoWrite')).toBe('planning');
    expect(describeWork('WebSearch')).toBe('searching');
    expect(describeWork('WebFetch')).toBe('fetching');
    expect(describeWork('MultiEdit')).toBe('editing');
    expect(describeWork('replace_file_content')).toBe('editing');
  });

  test('a tool nobody recognises is still doing something', () => {
    // Falling back to the engine's own name would read as jargon in a sentence
    // about waiting, and the activity above the line already names the tool.
    expect(describeWork('mcp__weird__thing')).toBe('working');
    expect(describeWork('')).toBe('working');
  });
});

describe('describeTurn', () => {
  test('a turn that has reported nothing is thinking', () => {
    // Which is what every engine does first, and the honest thing to say before
    // anything has arrived.
    expect(describeTurn(undefined)).toBe('thinking…');
  });

  test('arriving text is answering, not thinking', () => {
    expect(describeTurn({ kind: 'text' })).toBe('answering…');
  });

  test('a paragraph already stored is not still being answered', () => {
    // A turn flushes what it has said before running a tool, so this is the pause
    // between the two rather than an answer under way.
    expect(describeTurn({ kind: 'text', finished: true })).toBe('thinking…');
  });

  test('arriving thinking is thinking', () => {
    expect(describeTurn({ kind: 'reasoning' })).toBe('thinking…');
  });

  test('a call still running is named by what it does', () => {
    expect(describeTurn({ kind: 'activity', tool: 'Bash' })).toBe('running…');
  });

  test('a call that is over hands the turn back to thinking', () => {
    // A finished call is not what the turn is doing any more, and the line used to
    // sit on it for the whole time the model spent deciding what came next.
    expect(describeTurn({ kind: 'activity', tool: 'Read', finished: true })).toBe('thinking…');
  });
});
