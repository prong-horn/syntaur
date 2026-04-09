import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

export function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export async function confirmPrompt(
  question: string,
  defaultValue: boolean = false,
): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    throw new Error('Interactive confirmation requires a TTY.');
  }

  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const rl = createInterface({ input, output });

  try {
    const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
    if (answer === '') {
      return defaultValue;
    }
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function textPrompt(
  question: string,
  defaultValue?: string,
): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('Interactive input requires a TTY.');
  }

  const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
  const rl = createInterface({ input, output });

  try {
    const answer = (await rl.question(`${question}${suffix}`)).trim();
    if (answer === '' && defaultValue !== undefined) {
      return defaultValue;
    }
    return answer;
  } finally {
    rl.close();
  }
}
