export function preferredEnvironmentValue(name: string, legacySuffix: string, values: Record<string, string | undefined> = process.env): string | undefined {
  if (values[name] !== undefined) return values[name];
  const candidates = [...new Set(Object.entries(values).filter(([key, value]) => key.endsWith(legacySuffix) && Boolean(value?.trim())).map(([, value]) => value!))];
  if (candidates.length > 1) throw new Error(`Multiple legacy values found; configure ${name} explicitly`);
  return candidates[0];
}
