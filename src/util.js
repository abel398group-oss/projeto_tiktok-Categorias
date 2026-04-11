export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function randomBetween(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
