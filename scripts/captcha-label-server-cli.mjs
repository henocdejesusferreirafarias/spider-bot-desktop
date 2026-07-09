import { startLabelServer } from './captcha-label-server.mjs';

try {
  const port = Number(process.env.LABEL_PORT ?? 8765);
  const server = await startLabelServer({ port });
  console.log(`Listening on http://127.0.0.1:${server.port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
