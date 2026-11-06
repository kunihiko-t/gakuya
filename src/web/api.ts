import type { StreamState } from '../shared/types.ts';

export async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
  const value = await res.json().catch(() => null);
  if (!res.ok) throw new Error(value?.error ?? `${res.status}`);
  return value;
}

export async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(path);
  return res.ok ? res.json() : null;
}

export function stream(onState: (s: StreamState) => void, onLost: () => void): void {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => onState(JSON.parse(m.data));
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) onLost(); };
}
