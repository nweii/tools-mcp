// ABOUTME: Process entry — builds the app via createApp() and starts it with the kit's startServer,
// which persists Claude-facing tokens on SIGTERM/SIGINT. createAuth refuses to construct when the
// OAuth approval page is unguarded, so a misconfigured deployment fails fast here rather than booting.
import { startServer } from 'mcp-server-kit';
import { createApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3457', 10);

let built: ReturnType<typeof createApp>;
try {
  built = createApp();
} catch (err) {
  console.error(`[auth] ${(err as Error).message}`);
  process.exit(1);
}

const { app, auth } = built;

startServer({
  app,
  port: PORT,
  onListen: () => console.log(`tools-mcp listening on port ${PORT}`),
  // Persist Claude-facing tokens on clean shutdown so clients survive container restarts.
  onShutdown: () => auth.saveTokens(),
});
