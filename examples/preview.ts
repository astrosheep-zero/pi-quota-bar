// Offline mock: no credentials, no HTTP, no Pi session.
import { renderBar } from '../src/bar/bar.ts';
import type { Paint } from '../src/bar/bar.ts';
import { quotaElement, renderFooter, renderUsage } from '../src/bar/quota.ts';
import type { QuotaState } from '../src/query/types.ts';

const now = Date.now();
const colors = { text: 39, dim: 90, success: 32, warning: 33, error: 31 };
const paint: Paint = process.env.NO_COLOR !== undefined ? (_tone, text) => text
  : (tone, text) => `\x1b[${colors[tone]}m${text}\x1b[0m`;
function mock(short: number, weekly: number): QuotaState {
  return { kind: 'ready', provider: 'openai-codex', label: 'Codex', snapshot: {
    fetchedAt: now, windows: [
      { id: '5h', label: '5h', durationSeconds: 18000, remainingPercent: short, resetAt: now + 8100000 },
      { id: '1w', label: '1w', durationSeconds: 604800, remainingPercent: weekly, resetAt: now + 442800000 },
    ],
  } };
}
console.log('MOCK DATA — no live queries\n');
for (const [short, weekly] of [[72, 85], [25, 60], [8, 50], [0, 50]]) {
  console.log(renderFooter(mock(short, weekly), paint, now));
}
console.log('\n/usage\n');
console.log(renderUsage(mock(72, 85), paint, now).join('\n'));
console.log('\nComposed bar\n');
console.log(renderBar([
  { id: 'context', spans: [{ text: 'ctx [▃] 32%', tone: 'dim' }] },
  quotaElement(mock(72, 85), now),
  { id: 'git', spans: [{ text: 'main', tone: 'dim' }] },
], paint));
