import { createFileRoute } from "@tanstack/react-router";
import { GFWR_QUERIES } from "@/lib/gfw-queries";

export const Route = createFileRoute("/api/gfwr/queries")({
  server: {
    handlers: {
      GET: async () => Response.json({ queries: GFWR_QUERIES }),
    },
  },
});