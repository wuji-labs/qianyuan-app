import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

export type SpecialCommandQueue<Mode, Message> = {
  push: (message: Message, mode: Mode, opts?: { userMessageSeq?: number | null }) => void;
  pushIsolateAndClear: (message: Message, mode: Mode, opts?: { userMessageSeq?: number | null }) => void;
};

/**
 * Push user input to a mode-aware queue, handling slash-style clear commands consistently.
 */
export function pushMessageToQueueWithSpecialCommands<Mode, Message>(opts: {
  queue: SpecialCommandQueue<Mode, Message>;
  message: Message;
  text: string;
  mode: Mode;
  userMessageSeq?: number | null;
}): void {
  const special = parseSpecialCommand(opts.text);
  const queueOptions = { userMessageSeq: opts.userMessageSeq ?? null };
  if (special.type === 'clear') {
    opts.queue.pushIsolateAndClear(opts.message, opts.mode, queueOptions);
    return;
  }
  opts.queue.push(opts.message, opts.mode, queueOptions);
}
