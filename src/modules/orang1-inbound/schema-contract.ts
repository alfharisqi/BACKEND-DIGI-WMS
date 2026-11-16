// Explicit semantic mapping between the existing local enum and Supabase's text CHECK values.
export const nativeTagTypes: Record<string, string> = {
  STANDARD_LABEL: 'Label Biasa (UHF)',
  ON_METAL: 'On-Metal (Logam/Cairan)',
  HARD_TAG: 'Hard Tag (Aset)',
};
export function canonicalTagType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(nativeTagTypes, value)) return value;
  return Object.keys(nativeTagTypes).find(key => nativeTagTypes[key] === value) ?? null;
}
