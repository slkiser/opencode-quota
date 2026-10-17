/**
 * Dashboard HTTP API server.
 *
 * Headless JSON API only (no HTML/CSS/JS UI) - the menubar app is the UI now,
 * reading DashboardApi directly in-process. This server exists for
 * programmatic/headless access to the same historical quota data without
 * running the Electron app at all.
 */

import type { Server } from "http";
import { DashboardApi } from "./api.js";

// Type for Express-like interface (avoiding direct dependency until added to package.json)
interface ExpressLike {
  get(path: string, handler: (req: any, res: any) => void | Promise<void>): void;
  listen(port: number, host: string, callback: () => void): Server;
}

export interface DashboardServerOptions {
  port: number;
  dbPath?: string;
  dashboardApi?: DashboardApi;
}

/**
 * Start the dashboard HTTP server
 * Note: Requires express to be installed. Add to package.json:
 *   "express": "^4.18.2"
 */
export async function startDashboardServer(options: DashboardServerOptions): Promise<Server> {
  const { port, dashboardApi } = options;

  if (!dashboardApi) {
    throw new Error("DashboardApi instance required");
  }

  // Dynamic import to avoid hard dependency until express is added
  let express: any;
  try {
    express = await import("express");
  } catch {
    throw new Error(
      "Express not installed. Run: pnpm add express\n" +
        "Also add types: pnpm add -D @types/express",
    );
  }

  const app: ExpressLike = express.default();

  // API routes
  app.get("/api/dashboard/providers", async (_req: any, res: any) => {
    try {
      res.json({ providers: dashboardApi.listProviders() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/dashboard/summary", async (req: any, res: any) => {
    try {
      const providers = req.query.providers?.toString().split(",") || ["anthropic"];
      const days = parseInt(req.query.days?.toString() || "7", 10);

      const summary = {
        providers: providers.map((provider: string) => ({
          provider,
          currentQuota: dashboardApi.getCurrentQuota(provider),
          quotaHistory: dashboardApi.getQuotaHistory(provider, days),
          modelBreakdown: dashboardApi.getModelBreakdown(provider, days),
          weeklyResets: dashboardApi.getWeeklyResets(provider, 4),
        })),
        timestamp: Date.now(),
      };

      res.json(summary);
    } catch (err) {
      console.error("Dashboard API error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/dashboard/quota-history/:provider", async (req: any, res: any) => {
    try {
      const { provider } = req.params;
      const days = parseInt(req.query.days?.toString() || "7", 10);
      const history = dashboardApi.getQuotaHistory(provider, days);
      res.json({ provider, history });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/dashboard/usage-breakdown/:provider", async (req: any, res: any) => {
    try {
      const { provider } = req.params;
      const days = parseInt(req.query.days?.toString() || "7", 10);
      const breakdown = dashboardApi.getModelBreakdown(provider, days);
      res.json({ provider, breakdown });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`📊 Token Watcher dashboard API running at http://localhost:${port}`);
    console.log(
      `   Headless JSON API only — see /api/dashboard/* routes. Use the menubar app for a UI.`,
    );
  });

  return server;
}
