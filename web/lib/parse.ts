export function parseJsonArray<T>(raw: string): T[] {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```\n?/g, "");
    const match = cleaned.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```\n?/g, "");
    const match = cleaned.match(/\{[\s\S]*\}/);
    return match ? (JSON.parse(match[0]) as T) : null;
  } catch {
    return null;
  }
}
