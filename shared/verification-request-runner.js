import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const rbclawRepoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function main() {
  const [repoDir, requestJson] = process.argv.slice(2);

  if (!repoDir || !requestJson) {
    throw new Error(
      'usage: bun shared/verification-request-runner.js <repoDir> <requestJson>',
    );
  }

  const verificationModuleUrl = pathToFileURL(
    path.join(rbclawRepoDir, 'src', 'verification.ts'),
  ).href;
  const verificationModule = await import(verificationModuleUrl);
  const request = JSON.parse(requestJson);
  const result = await verificationModule.runVerificationRequest(request, {
    repoDir,
  });

  process.stdout.write(
    JSON.stringify({
      requestId: request.requestId,
      ...result,
    }),
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
});
