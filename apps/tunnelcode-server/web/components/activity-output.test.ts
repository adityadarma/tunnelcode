import { describe, expect, test } from 'vitest';
import { withoutNumberSeparators } from './activity-output.js';

describe('withoutNumberSeparators', () => {
  test('a read keeps its numbers and loses the colons', () => {
    // What opencode's read tool prints inside its envelope, padded so the numbers
    // line up. The padding is part of the gutter and stays.
    const output = [
      '  8: ',
      '  9: class StoreTransactionRequest extends BaseRequest',
      ' 10: {',
      ' 11:     public function authorize(): bool',
      '(End of file - total 11 lines)',
    ].join('\n');

    expect(withoutNumberSeparators(output)).toBe(
      [
        '  8',
        '  9 class StoreTransactionRequest extends BaseRequest',
        ' 10 {',
        ' 11     public function authorize(): bool',
        '(End of file - total 11 lines)',
      ].join('\n'),
    );
  });

  test('a colon inside the line itself is left alone', () => {
    // Only the separator that follows the number goes. The code on the line is not
    // touched, however many colons it carries.
    expect(withoutNumberSeparators('1: a: b: c\n2: d')).toBe('1 a: b: c\n2 d');
  });

  test('grep context and matches read the same way', () => {
    // grep -n marks a match with a colon and a line of context with a dash. Both are
    // separators, and the distinction is not worth a character in front of every
    // line of code.
    const output = ['129-', '130:interface AgyLine {', '131-  event?: unknown;', '132-}'].join(
      '\n',
    );

    expect(withoutNumberSeparators(output)).toBe(
      ['129', '130 interface AgyLine {', '131   event?: unknown;', '132 }'].join('\n'),
    );
  });

  test('numbers of any width are numbers', () => {
    const output = ['9: a', '10: b'].join('\n');

    expect(withoutNumberSeparators(output)).toBe(['9 a', '10 b'].join('\n'));

    const wide = ['9998: a', '9999: b', '10000: c'].join('\n');

    expect(withoutNumberSeparators(wide)).toBe(['9998 a', '9999 b', '10000 c'].join('\n'));
  });

  test('a hunk that starts again is still numbering', () => {
    // grep separates hunks with `--`, which breaks the count and starts the next run.
    const output = ['10-a', '11:b', '--', '80-c', '81:d'].join('\n');

    expect(withoutNumberSeparators(output)).toBe(['10 a', '11 b', '--', '80 c', '81 d'].join('\n'));
  });

  test('a dated log line is not a numbered line', () => {
    // The shape is the same, digits and a dash, and cutting it would rewrite the
    // dates. What tells them apart is that these do not count up by one.
    const output = ['2026-08-03 started', '2026-08-03 finished'].join('\n');

    expect(withoutNumberSeparators(output)).toBe(output);
  });

  test('one numbered line on its own is left as it came', () => {
    // Nothing here says the number is a line number rather than the output's own
    // text, and a single line costs nothing to read as it is.
    expect(withoutNumberSeparators('42: answer')).toBe('42: answer');
  });

  test('output with no numbering at all is untouched', () => {
    const output = ['$ npm run build', 'built in 2.1s', ''].join('\n');

    expect(withoutNumberSeparators(output)).toBe(output);
  });
});
