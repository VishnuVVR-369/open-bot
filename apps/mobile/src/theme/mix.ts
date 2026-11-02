function rgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `amount` of `color` over `base`, like CSS `color-mix(in srgb, color amount, base)`. */
export function mix(color: string, base: string, amount: number): string {
  const a = rgb(color);
  const b = rgb(base);
  const channel = (i: number) =>
    Math.round(a[i]! * amount + b[i]! * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}
