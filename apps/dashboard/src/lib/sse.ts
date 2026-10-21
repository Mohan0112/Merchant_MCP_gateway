import type { ChatEvent } from '@ahjin/contracts';

/**
 * Incremental parser for the chat's server-sent events. Feed it chunks as they arrive; it returns
 * the complete events and keeps a partial one until the rest comes in.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): ChatEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: ChatEvent[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          events.push(JSON.parse(data) as ChatEvent);
        } catch {
          // A malformed event is skipped rather than ending the whole answer.
        }
      }
      boundary = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}
