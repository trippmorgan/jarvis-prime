#!/usr/bin/env node
/**
 * /projects — backing node script (W5.b).
 *
 * Resolves the canonical jarvis-os portfolio-surface service, calls
 * `getActivePortfolio()`, and prints Telegram-ready markdown to stdout.
 *
 * Env vars:
 *   JARVIS_OS_ROOT           — path to jarvis-os repo (default: /home/tripp/.openclaw/workspace/jarvis-os)
 *   PROJECT_STATE_STORE_ROOT — canonical store root (takes priority over all others)
 *   HIPPOCAMPUS_ROOT         — one-release bridge alias; used when PROJECT_STATE_STORE_ROOT is absent
 *                              (default: <JARVIS_OS_ROOT>/.data/project-state)
 *
 * Trust contract enforcement is upstream in the service — this script is
 * render-only. We do not parse STATE.md, run SQL, or re-derive anything.
 * If the service throws, we print a degraded warning and exit non-zero so
 * the caller knows the answer is "I don't know," not "let me guess."
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { formatPortfolioForTelegram } from './format.mjs';

const DEFAULT_JARVIS_OS_ROOT = '/home/tripp/.openclaw/workspace/jarvis-os';

function resolveJarvisOsRoot() {
  return process.env.JARVIS_OS_ROOT && process.env.JARVIS_OS_ROOT.length > 0
    ? process.env.JARVIS_OS_ROOT
    : DEFAULT_JARVIS_OS_ROOT;
}

function resolveStoreRoot(repoRoot) {
  if (process.env.PROJECT_STATE_STORE_ROOT && process.env.PROJECT_STATE_STORE_ROOT.length > 0) {
    return process.env.PROJECT_STATE_STORE_ROOT;
  }
  if (process.env.HIPPOCAMPUS_ROOT && process.env.HIPPOCAMPUS_ROOT.length > 0) {
    return process.env.HIPPOCAMPUS_ROOT;
  }
  return resolve(repoRoot, '.data', 'project-state');
}

async function main() {
  const repoRoot = resolveJarvisOsRoot();
  const storeRoot = resolveStoreRoot(repoRoot);

  // Import the canonical service from jarvis-os/dist. The TypeScript source
  // compiles to CommonJS under tsconfig.daemon.json, so we use createRequire
  // to bridge ESM ↔ CJS. Prefer dist (built); fall back to src via tsx would
  // be a future v2 — for now require the build artifact.
  const require = createRequire(import.meta.url);

  let PortfolioSurfaceService;
  let ProjectStateStore;
  try {
    const svcMod = require(
      resolve(repoRoot, 'dist', 'services', 'portfolio-surface', 'portfolio-surface-service.js')
    );
    const storeMod = require(
      resolve(repoRoot, 'dist', 'services', 'hippocampus', 'project-state-store.js')
    );
    PortfolioSurfaceService = svcMod.PortfolioSurfaceService;
    ProjectStateStore = storeMod.ProjectStateStore;
  } catch (err) {
    // Service unreachable — degraded by definition. Match the Trust Contract:
    // refuse to fall back to assistant recall.
    process.stdout.write(
      [
        '[T0 READ] /projects — DEGRADED',
        `⚠ Portfolio service unreachable: ${err?.message ?? String(err)}`,
        'Recommend: check jarvis-os logs.',
      ].join('\n') + '\n',
    );
    process.exit(2);
    return;
  }

  if (typeof PortfolioSurfaceService !== 'function' || typeof ProjectStateStore !== 'function') {
    process.stdout.write(
      [
        '[T0 READ] /projects — DEGRADED',
        '⚠ Portfolio service exports missing (PortfolioSurfaceService or ProjectStateStore not found).',
        'Recommend: check jarvis-os logs.',
      ].join('\n') + '\n',
    );
    process.exit(2);
    return;
  }

  const store = new ProjectStateStore(storeRoot);
  const service = new PortfolioSurfaceService({ store });

  let envelope;
  try {
    envelope = await service.getActivePortfolio();
  } catch (err) {
    process.stdout.write(
      [
        '[T0 READ] /projects — DEGRADED',
        `⚠ Portfolio query failed: ${err?.message ?? String(err)}`,
        'Recommend: check jarvis-os logs.',
      ].join('\n') + '\n',
    );
    process.exit(2);
    return;
  }

  const output = formatPortfolioForTelegram(envelope);
  process.stdout.write(output + '\n');
}

main().catch((err) => {
  process.stdout.write(
    [
      '[T0 READ] /projects — DEGRADED',
      `⚠ Unexpected render error: ${err?.message ?? String(err)}`,
      'Recommend: check jarvis-os logs.',
    ].join('\n') + '\n',
  );
  process.exit(2);
});
