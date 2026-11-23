/** Shown instantly while the next dashboard page loads, so a click always gets feedback. */
export default function DashboardLoading() {
  return (
    <div className="flex-1" aria-busy="true" aria-label="Loading page">
      <div className="h-16 border-b border-slate-200/70 px-4 sm:px-6 lg:px-8 flex items-center">
        <div className="space-y-2">
          <div className="h-4 w-40 rounded-md bg-slate-200/70 animate-pulse" />
          <div className="h-3 w-56 rounded-md bg-slate-200/50 animate-pulse" />
        </div>
      </div>
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] mx-auto">
        <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-2xl bg-white ring-1 ring-slate-200/70 animate-pulse" />
          ))}
        </div>
        <div className="h-72 rounded-2xl bg-white ring-1 ring-slate-200/70 animate-pulse" />
      </div>
    </div>
  );
}
