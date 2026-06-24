import { createFileRoute } from "@tanstack/react-router";
import { getTrack } from "@/lib/gfw.server";

export const Route = createFileRoute("/api/gfw/track")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const vesselId = url.searchParams.get("vessel_id") || "";
        const startDate = url.searchParams.get("start_date") || "";
        const endDate = url.searchParams.get("end_date") || "";
        if (!vesselId || !startDate || !endDate) {
          return Response.json({ error: "vessel_id, start_date, end_date required" }, { status: 400 });
        }
        try {
          const data = await getTrack(vesselId, startDate, endDate);
          return Response.json(data);
        } catch (e: any) {
          return Response.json({ error: e?.message || "track failed" }, { status: 500 });
        }
      },
    },
  },
});