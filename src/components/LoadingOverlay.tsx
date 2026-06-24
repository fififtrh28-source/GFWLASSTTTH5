export default function LoadingOverlay({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center pointer-events-none">
      <div className="glass rounded-2xl px-6 py-5 flex items-center gap-3 pointer-events-auto">
        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <div className="text-sm text-foreground">{label}</div>
      </div>
    </div>
  );
}