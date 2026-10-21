export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-16">
      <p className="mb-6 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Cultural experimentation studio
      </p>
      <h1 className="mb-6 font-serif text-6xl tracking-tight sm:text-7xl">
        Tessaloom
      </h1>
      <p className="max-w-xl text-2xl leading-relaxed">
        Where Different Worlds Create New Possibilities.
      </p>
      <div className="mt-12 rounded-lg border bg-card p-6 text-card-foreground">
        <h2 className="font-semibold">The studio is taking shape.</h2>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          This is the foundation preview. Cultural discovery, experiments, and
          experience blueprints are not available yet.
        </p>
      </div>
    </main>
  );
}
