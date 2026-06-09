export function extractErrorMsg(e: unknown): string {
  if (typeof e === 'string') return e || 'Transaction failed';
  if (e instanceof Error) {
    const msg = e.message;
    if (msg && msg !== '[object Object]') return msg;
  }
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const msg = (obj.message ?? obj.msg ?? obj.error ?? obj.reason) as string | undefined;
    if (msg && typeof msg === 'string' && msg !== '[object Object]') return msg;
    try {
      const json = JSON.stringify(e);
      if (json && json !== '{}') {
        const lower = json.toLowerCase();
        if (lower.includes('reject') || lower.includes('declin') || lower.includes('cancel') || lower.includes('denied') || lower.includes('user refused'))
          return 'Transaction rejected by wallet';
        return json.length > 160 ? json.slice(0, 160) + '…' : json;
      }
    } catch { /* ignore */ }
  }
  return 'Transaction failed or rejected';
}
