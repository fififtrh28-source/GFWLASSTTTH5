import { createFileRoute } from "@tanstack/react-router";
import { searchVessels } from "@/lib/gfw.server";

export const Route = createFileRoute("/api/gfw/vessels/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = url.searchParams.get("query") || "";
        const limit = Math.min(50, Number(url.searchParams.get("limit") || "20"));
        if (!query.trim()) {
          return Response.json({ entries: [] });
        }
        try {
          const vessels = await searchVessels(query, limit);
          return Response.json({ entries: vessels });
        } catch (e: any) {
          return Response.json({ vessels: [], error: e?.message || "search failed" }, { status: 500 });
        }
      },
    },
  },
});