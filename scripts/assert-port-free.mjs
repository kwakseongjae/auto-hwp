#!/usr/bin/env node

import { createServer } from "node:net";

const port = Number(process.argv[2]);
const host = process.argv[3] ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("usage: node scripts/assert-port-free.mjs <port> [host]");
  process.exitCode = 2;
} else {
  const server = createServer();

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[assert-port-free] ${host}:${port} is already in use; stop the stale desktop dev server and retry.`,
      );
      process.exitCode = 1;
      return;
    }

    console.error(`[assert-port-free] could not probe ${host}:${port}: ${error.message}`);
    process.exitCode = 2;
  });

  server.listen({ host, port, exclusive: true }, () => {
    server.close((error) => {
      if (error) {
        console.error(`[assert-port-free] could not release ${host}:${port}: ${error.message}`);
        process.exitCode = 2;
      }
    });
  });
}
