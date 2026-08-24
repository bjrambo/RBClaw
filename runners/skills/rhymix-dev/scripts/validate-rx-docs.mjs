#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(skillDir, 'references', 'rx-docs');
const requiredFiles = ['llms.txt', 'README.md', 'PROMPT.md', '.source.json'];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const errors = [];
for (const requiredFile of requiredFiles) {
  if (!fs.existsSync(path.join(docsDir, requiredFile))) {
    errors.push(`missing required file: ${requiredFile}`);
  }
}

const files = walk(docsDir);
const documentationFiles = files.filter(
  (filePath) => filePath.endsWith('.md') || filePath.endsWith('llms.txt'),
);
if (documentationFiles.length < 90) {
  errors.push(`expected at least 90 documentation files, found ${documentationFiles.length}`);
}

const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const sourcePath of documentationFiles) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  for (const match of source.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (
      !rawTarget ||
      rawTarget.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
    ) {
      continue;
    }

    const targetWithoutAnchor = decodeURIComponent(rawTarget.split('#', 1)[0]);
    const targetPath = path.resolve(path.dirname(sourcePath), targetWithoutAnchor);
    if (!targetPath.startsWith(`${docsDir}${path.sep}`) && targetPath !== docsDir) {
      errors.push(`${path.relative(docsDir, sourcePath)}: link escapes corpus: ${rawTarget}`);
    } else if (!fs.existsSync(targetPath)) {
      errors.push(`${path.relative(docsDir, sourcePath)}: missing link target: ${rawTarget}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(
  `rx-docs validation OK (${documentationFiles.length} docs, ${files.length} files)`,
);
