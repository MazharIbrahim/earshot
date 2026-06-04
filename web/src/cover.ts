// Deterministic gradient generator — every project name gets a unique cover
// without the producer ever uploading artwork.

function hash(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function coverGradient(name: string): string {
  const h1 = hash(name);
  const h2 = hash(name + 'b');
  const hue1 = h1 % 360;
  const hue2 = (hue1 + 40 + (h2 % 80)) % 360;
  const angle = h2 % 360;
  return `linear-gradient(${angle}deg,
    hsl(${hue1} 60% 22%) 0%,
    hsl(${hue2} 70% 32%) 100%)`;
}
