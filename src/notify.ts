const NOTIFY_TIMEOUT_MS = 5_000;

export async function notifyBackend(path: string, payload: unknown): Promise<void> {
  const base = process.env.BACKEND_URL;
  if (!base) return;
  const token = process.env.BACKEND_TOKEN;

  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[router] notify ${path} → ${res.status}`);
    }
  } catch (err) {
    // Best-effort — observability MUST NOT block the lifecycle callback.
    // Log a short message so silent backend outages are visible.
    console.warn(`[router] notify ${path} failed:`, err instanceof Error ? err.message : err);
  }
}
