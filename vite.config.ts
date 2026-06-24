import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  for (const fileName of [".env", ".env.local", ".env.lokal"]) {
    const envFile = path.join(__dirname, fileName);
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

function resolveHandler(urlPath: string): string | null {
  const clean = urlPath.split("?")[0].replace(/\/$/, "");
  const candidates = [
    path.join(__dirname, clean + ".js"),
    path.join(__dirname, clean, "index.js"),
  ];
  return candidates.find(fs.existsSync) ?? null;
}

function vercelApiPlugin() {
  return {
    name: "local-vercel-api",
    configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      loadDotEnv();

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith("/api/")) return next();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

        const handlerPath = resolveHandler(req.url);
        if (!handlerPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "API route not found: " + req.url }));
        }

        const urlObj = new URL(req.url, "http://localhost");
        const query: Record<string, string> = {};
        urlObj.searchParams.forEach((v, k) => { query[k] = v; });

        let bodyText = "";
        if (req.method === "POST") {
          bodyText = await new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          });
        }

        const mockReq = {
          method: req.method,
          query,
          headers: req.headers,
          body: bodyText ? (() => { try { return JSON.parse(bodyText); } catch { return bodyText; } })() : {},
        };

        const mockRes = {
          _status: 200,
          status(code: number) { this._status = code; return this; },
          setHeader(name: string, value: string) { res.setHeader(name, value); return this; },
          json(data: unknown) {
            res.setHeader("Content-Type", "application/json");
            res.statusCode = this._status;
            res.end(JSON.stringify(data));
          },
          end(body = "") { res.statusCode = this._status; res.end(body); },
        };

        try {
          const mod = await import(pathToFileURL(handlerPath).href);
          await (mod.default ?? mod)(mockReq, mockRes);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), tsConfigPaths(), vercelApiPlugin()],
});
