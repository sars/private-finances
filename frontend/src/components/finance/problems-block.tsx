import { ArrowRight, CircleAlert, TriangleAlert } from 'lucide-react';

/**
 * What has stopped and is waiting for the household, at the top of Home.
 *
 * It shows nothing at all when nothing is wrong. A panel that says "all good"
 * every day is one nobody reads by the end of the week, and the day it changes
 * is the day it gets skipped — so the block's absence is the reassurance, and
 * its presence always means something to do.
 *
 * Each row names the bank or the thing in the household's own words, says in
 * one sentence what it means, and links to the page where the fix is rather
 * than the page where the symptom shows. Codes, providers and error text stay
 * out: they belong in the logs, where somebody debugging will look for them.
 */
export type Problem = {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  href: string | null;
  since: string | null;
};

export function ProblemsBlock({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null;
  const critical = problems.some((p) => p.severity === 'critical');
  return (
    <section
      aria-label="Problems"
      className={`overflow-hidden rounded-lg border ${
        critical ? 'border-destructive/30' : 'border-warning/30'
      }`}
    >
      <div className="divide-y">
        {problems.map((problem) => {
          const bad = problem.severity === 'critical';
          const Icon = bad ? TriangleAlert : CircleAlert;
          const row = (
            <>
              <Icon
                aria-hidden
                className={`mt-0.5 size-4 shrink-0 ${
                  bad ? 'text-destructive' : 'text-warning'
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{problem.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {problem.detail}
                </p>
              </div>
              {problem.href && (
                <ArrowRight
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
              )}
            </>
          );
          const className = `flex items-start gap-3 px-4 py-3 ${
            bad ? 'bg-destructive/5' : 'bg-warning/5'
          }`;
          return problem.href ? (
            <a
              key={problem.id}
              href={problem.href}
              className={`${className} transition-colors hover:bg-muted/40`}
            >
              {row}
            </a>
          ) : (
            <div key={problem.id} className={className}>
              {row}
            </div>
          );
        })}
      </div>
    </section>
  );
}
