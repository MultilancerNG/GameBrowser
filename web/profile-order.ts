export interface OrderableProfile { id: string; name: string }

/** Selected profiles lead the workspace; the last selected profile is Admin. */
export function selectionRanks(selected: ReadonlySet<string>): Map<string, number> {
  return new Map([...selected].reverse().map((id, index) => [id, index]));
}

/** Preserve profiles outside the current filter when moving one visible row. */
export function moveProfile(
  ids: readonly string[], source: string, target: string, after = false,
): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const next = ids.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

export function orderedProfileIds(profiles: readonly OrderableProfile[], saved: readonly string[]): string[] {
  const available = new Set(profiles.map((profile) => profile.id));
  const result = [...new Set(saved)].filter((id) => available.has(id));
  const seen = new Set(result);
  for (const profile of profiles) if (!seen.has(profile.id)) { result.push(profile.id); seen.add(profile.id); }
  return result;
}
