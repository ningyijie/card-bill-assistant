import { z } from 'zod';

export function ollamaEnabled() {
  return Boolean(process.env.OFFERS_OLLAMA_URL?.trim() && process.env.OFFERS_OLLAMA_MODEL?.trim());
}

export async function askOllama(instructions: string, input: unknown, format: object, timeout: number, tokens: number) {
  if (!ollamaEnabled()) return null;
  try {
    const base = new URL(process.env.OFFERS_OLLAMA_URL!.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    const response = await fetch(new URL('/api/chat', base), {
      method: 'POST', signal: AbortSignal.timeout(timeout), redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OFFERS_OLLAMA_MODEL!.trim(), stream: false, format,
        options: { temperature: 0, num_predict: tokens },
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(input) }],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const data = z.object({ message: z.object({ content: z.string().max(48_000) }) }).parse(await response.json());
    return JSON.parse(data.message.content) as unknown;
  } catch { return null; }
}
