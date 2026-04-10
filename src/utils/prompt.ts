import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

export function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export function parseConfirmAnswer(
  answer: string,
  defaultValue: boolean = false,
): boolean | null {
  const normalized = answer.trim().toLowerCase();
  if (normalized === '') {
    return defaultValue;
  }
  if (normalized === 'y' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'n' || normalized === 'no') {
    return false;
  }
  return null;
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
    while (true) {
      const answer = await rl.question(`${question}${suffix}`);
      const parsed = parseConfirmAnswer(answer, defaultValue);
      if (parsed !== null) {
        return parsed;
      }
      console.log('Enter y, yes, n, no, or press Enter for the default.');
    }
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
