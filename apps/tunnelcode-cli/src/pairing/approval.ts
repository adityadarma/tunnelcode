import { writeOut } from '../output.js';
import { bold, green, greenBold } from '../style.js';

/**
 * What is being asked for.
 *
 * A resume is worded differently on purpose: nobody typed a code and nobody
 * scanned anything, so presenting it as a pairing request would describe an action
 * the user did not just take. See ADR-040.
 */
export type ApprovalPurpose = 'pair' | 'resume';

/**
 * Reads a single keypress without waiting for Enter, so approving a request costs
 * one key. Falls back to a line read when stdin is not a TTY, which keeps the CLI
 * usable from scripts and tests.
 */
export async function askApproval(
  approvalNumber: string,
  purpose: ApprovalPurpose = 'pair',
): Promise<boolean> {
  writeOut('');

  if (purpose === 'resume') {
    writeOut(
      `${green('✔')} ${bold('Reconnect request! Approval Number:')} ${greenBold(approvalNumber)}`,
    );
    writeOut('  A browser paired earlier wants to keep using this workspace.');
    writeOut('  Approve only if that browser shows this same number.');
    writeOut('  Press y to approve, n to end its session.');
  } else {
    writeOut(
      `${green('✔')} ${bold('Connection requested! Approval Number:')} ${greenBold(approvalNumber)}`,
    );
    writeOut('  Approve only if the browser shows this same number.');
    writeOut('  Press y to approve, n to reject.');
  }

  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return readLine(stdin);
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  try {
    return await readKey(stdin);
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    // Same reason as the line reader: a referenced stdin outlives the session.
    stdin.unref();
  }
}

function readKey(stdin: NodeJS.ReadStream): Promise<boolean> {
  return new Promise((resolve) => {
    const onData = (chunk: string): void => {
      const key = chunk.toLowerCase();

      if (key === 'y') {
        stdin.off('data', onData);
        resolve(true);
        return;
      }

      // Ctrl+C and Escape count as a refusal, so walking away never pairs.
      if (key === 'n' || key === '\u0003' || key === '\u001b') {
        stdin.off('data', onData);
        resolve(false);
      }
    };

    stdin.on('data', onData);
  });
}

function readLine(stdin: NodeJS.ReadStream): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (approved: boolean): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);

      // Reading put the stream into flowing mode. Pausing is not enough: the
      // handle stays referenced and keeps the event loop alive, so the CLI would
      // print that the session ended and then hang.
      stdin.pause();
      stdin.unref();
      resolve(approved);
    };

    const onData = (chunk: Buffer): void => {
      finish(chunk.toString('utf8').trim().toLowerCase().startsWith('y'));
    };

    // Closed input means nobody is there to approve, which is a refusal.
    const onEnd = (): void => {
      finish(false);
    };

    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}
