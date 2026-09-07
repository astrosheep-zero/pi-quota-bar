// A bar composes independent, already-computed elements. It never queries providers.
export type Tone = 'text' | 'dim' | 'success' | 'warning' | 'error';
export interface Span { text: string; tone?: Tone }
export interface BarElement { id: string; spans: readonly Span[] }
export type Paint = (tone: Tone, text: string) => string;
export const plain: Paint = (_tone, text) => text;

export function renderBar(elements: readonly BarElement[], paint: Paint = plain): string {
  const parts = elements.filter(element => element.spans.length > 0).map(element =>
    element.spans.map(span => paint(span.tone ?? 'text', span.text)).join(''));
  // Explicit trailing space is part of the public rendering contract.
  return parts.length ? parts.join(paint('dim', ' │ ')) + ' ' : '';
}

export function remainingTone(value: number | null): Tone {
  return value === null ? 'dim' : value <= 10 ? 'error' : value <= 30 ? 'warning' : 'success';
}

export function verticalBar(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '[?]';
  if (value <= 0) return '[·]';
  if (value >= 100) return '[█]';
  const height = Math.max(1, Math.min(7, Math.round(value * 8 / 100)));
  return `[${'▁▂▃▄▅▆▇'[height - 1]}]`;
}

export function horizontalBar(value: number | null, width = 20): string {
  width = Math.max(1, Math.min(80, Math.floor(width) || 20));
  if (value === null || !Number.isFinite(value)) return `[${'░'.repeat(width)}]`;
  const filled = value >= 100 ? width : value <= 0 ? 0
    : Math.min(width - 1, Math.round(value / 100 * width));
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return '?';
  const rounded = value > 0 && value < 100
    ? Math.max(0.1, Math.min(99.9, Math.round(value * 10) / 10)) : value;
  return `${rounded}%`;
}

export function duration(ms: number): string {
  if (ms <= 0) return 'due';
  if (ms < 60000) return '<1m';
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d${hours ? `${hours}h` : ''}`;
  return `${hours ? `${hours}h` : ''}${minutes % 60 ? `${minutes % 60}m` : ''}`;
}
