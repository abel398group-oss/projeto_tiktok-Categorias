import fsPromises from 'node:fs/promises';
import path from 'node:path';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function randomBetween(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Escrever ficheiro de forma atómica: mesmo diretório, `.nome.tmp` → rename para o destino.
 * Evita deixar o ficheiro final truncado se o processo morrer durante a escrita.
 * @param {string} targetPath
 * @param {string} data
 * @param {BufferEncoding} [encoding]
 */
export async function writeFileAtomic(targetPath, data, encoding = 'utf8') {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.tmp`);
  try {
    await fsPromises.writeFile(tmpPath, data, encoding);
    await fsPromises.rename(tmpPath, targetPath);
  } catch (e) {
    await fsPromises.unlink(tmpPath).catch(() => {});
    throw e;
  }
}
