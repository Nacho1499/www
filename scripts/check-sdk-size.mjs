import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(import.meta.resolve('@wraith-protocol/sdk/chains/evm'));
const generatedFile = fileURLToPath(new URL('../src/generated/sdk-size.ts', import.meta.url));
const compressedBytes = gzipSync(readFileSync(entrypoint), { level: 9 }).length;
const sizeKilobytes = (compressedBytes / 1000).toFixed(1);
const generatedContent = `export const EVM_SDK_ESM_ENTRYPOINT_GZIP_KB = ${sizeKilobytes};\n`;

if (process.argv.includes('--write')) {
  writeFileSync(generatedFile, generatedContent);
  console.log(`Generated EVM ESM entrypoint size: ${sizeKilobytes} kB (gzip level 9)`);
} else {
  const currentContent = readFileSync(generatedFile, 'utf8');
  if (currentContent !== generatedContent) {
    console.error(
      `SDK size copy is out of date: expected ${sizeKilobytes} kB (gzip level 9). Run pnpm generate:sdk-size.`,
    );
    process.exitCode = 1;
  }
}
