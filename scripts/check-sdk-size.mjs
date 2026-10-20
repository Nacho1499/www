import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(import.meta.resolve('@wraith-protocol/sdk/chains/evm'));
const generatedFile = fileURLToPath(new URL('../src/generated/sdk-size.ts', import.meta.url));
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(import.meta.resolve('@wraith-protocol/sdk/chains/evm'));
const generatedFileArgument = process.argv.indexOf('--generated-file');

if (generatedFileArgument !== -1 && !process.argv[generatedFileArgument + 1]) {
  console.error('Missing path after --generated-file.');
  process.exit(1);
}

const generatedFile =
  generatedFileArgument === -1
    ? fileURLToPath(new URL('../src/generated/sdk-size.ts', import.meta.url))
    : resolve(process.argv[generatedFileArgument + 1]);
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
