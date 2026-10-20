import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const checkerPath = join(root, 'scripts/check-sdk-size.mjs');

describe('build validation gates', () => {
  it('runs content validation and SDK-size validation from one build script', () => {
    const packageSource = readFileSync(join(root, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageSource) as { scripts: { build: string } };

    expect(packageSource.match(/"build"\s*:/g)).toHaveLength(1);
    expect(packageJson.scripts.build).toMatch(
      /^tsx scripts\/validate-content\.ts && node scripts\/check-sdk-size\.mjs &&/,
    );
  });

  it('rejects a stale generated SDK size', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'wraith-sdk-size-'));
    const generatedFile = join(tempDirectory, 'sdk-size.ts');

    try {
      execFileSync(process.execPath, [checkerPath, '--write', '--generated-file', generatedFile]);

      writeFileSync(generatedFile, 'export const EVM_SDK_ESM_ENTRYPOINT_GZIP_KB = 9999.9;\n');

      const result = spawnSync(process.execPath, [checkerPath, '--generated-file', generatedFile], {
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('SDK size copy is out of date');
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
