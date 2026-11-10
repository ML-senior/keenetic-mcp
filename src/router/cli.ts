import { ValidationError } from './errors.js';
import type { Rci } from './rci.js';

/**
 * Runs one line of router CLI through RCI's `parse` command.
 *
 * Every RCI command is a CLI command spelled as JSON, but the JSON spelling of
 * a positional argument is not written down anywhere and a wrong guess is
 * accepted in silence. The CLI spelling is in the vendor's command reference.
 * Where a command is only known in that form, sending the line itself is the
 * honest option: the router parses it exactly as it would at the console, and
 * rejects what it does not understand with an error instead of `{}`.
 *
 * An error status anywhere in the answer is raised by the RCI layer, so a
 * resolved promise means the router accepted the line.
 */
export async function runCli(rci: Rci, line: string): Promise<unknown> {
  const answer = await rci.post({ parse: line });
  return typeof answer === 'object' && answer !== null && 'parse' in answer
    ? (answer as { parse: unknown }).parse
    : answer;
}

/**
 * One CLI word, or a refusal.
 *
 * The line is assembled from tool arguments, and the CLI splits on whitespace:
 * an argument carrying a space or a newline would become extra words - a
 * different command. Arguments are therefore held to a single plain token.
 */
export function cliWord(value: string, what: string): string {
  const word = value.trim();
  if (word === '' || /[\s"'\;|&<>`$!?]/.test(word) || /[\u0000-\u001f\u007f]/.test(word)) {
    throw new ValidationError(
      `${what} "${value}" cannot be sent to the router: it must be a single word without ` +
        'spaces, quotes or control characters.'
    );
  }
  return word;
}
