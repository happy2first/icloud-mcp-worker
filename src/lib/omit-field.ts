// Exclude a field from a copy without mutating the source or binding an unused value.
export function omitField<T extends object, K extends keyof T>(
  value: T,
  field: K,
): Omit<T, K> {
  const copy = { ...value };
  Reflect.deleteProperty(copy, field);
  return copy;
}
