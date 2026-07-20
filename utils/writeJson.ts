import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export function writeJobsToDisk(jobs: unknown[], outDir = 'output'): string {
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(outDir, `fieldglass-jobs-${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(jobs, null, 2), 'utf-8');
  return filePath;
}
