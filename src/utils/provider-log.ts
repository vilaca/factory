import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ProviderLogEvent {
  provider: string;
  category: 'auth' | 'diagnostic' | 'startup';
  action: string;
  outcome?: 'started' | 'success' | 'error' | 'skipped';
  detail: string;
}

function providerEventsLogPath(): string {
  return path.join(os.homedir(), '.factory', 'provider-events.jsonl');
}

export function appendProviderLog(event: ProviderLogEvent): void {
  try {
    const filePath = providerEventsLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...event,
      }) + '\n',
    );
  } catch {
    // Logging failures must never crash startup or the REPL
  }
}
