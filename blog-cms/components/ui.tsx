import { cn } from '@/lib/utils';

export function Button({ className, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  return (
    <button
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-leaf text-white hover:bg-[#105536]',
        variant === 'secondary' && 'border border-line bg-white text-ink hover:bg-[#f7faf6]',
        variant === 'danger' && 'bg-[#b83232] text-white hover:bg-[#9d2727]',
        variant === 'ghost' && 'text-ink hover:bg-[#edf3ee]',
        className
      )}
      {...props}
    />
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('min-h-10 w-full rounded-md border border-line bg-white px-3 text-sm outline-none focus:border-leaf', props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn('min-h-24 w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-leaf', props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn('min-h-10 w-full rounded-md border border-line bg-white px-3 text-sm outline-none focus:border-leaf', props.className)} />;
}

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <section {...props} className={cn('rounded-lg border border-line bg-white p-4 shadow-panel', className)} />;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2 text-sm font-bold text-[#33443a]">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue'; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex rounded-full px-2.5 py-1 text-xs font-bold',
      tone === 'neutral' && 'bg-[#edf3ee] text-[#405148]',
      tone === 'green' && 'bg-[#e5f6eb] text-[#176b45]',
      tone === 'amber' && 'bg-[#fff3d8] text-[#8a5a10]',
      tone === 'red' && 'bg-[#ffe7e7] text-[#a12d2d]',
      tone === 'blue' && 'bg-[#e6f0ff] text-[#25598f]'
    )}>{children}</span>
  );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" {...props} className={cn('animate-pulse rounded-md bg-[#e6eee8]', className)} />;
}

export function SkeletonCard({ className, lines = 3, media = true }: { className?: string; lines?: number; media?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-line bg-white p-4 shadow-panel', className)} aria-busy="true">
      {media && <Skeleton className="mb-4 aspect-video w-full" />}
      <div className="grid gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-4/5" />
        {Array.from({ length: lines }).map((_, index) => <Skeleton key={index} className={cn('h-3', index === lines - 1 ? 'w-2/3' : 'w-full')} />)}
      </div>
    </div>
  );
}

export function SkeletonGrid({ className, count = 6, lines = 3, media = true }: { className?: string; count?: number; lines?: number; media?: boolean }) {
  return (
    <div className={cn('grid gap-4 md:grid-cols-2 xl:grid-cols-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, index) => <SkeletonCard key={index} lines={lines} media={media} />)}
    </div>
  );
}

export function SkeletonTable({ className, rows = 6, columns = 5 }: { className?: string; rows?: number; columns?: number }) {
  return (
    <div className={cn('grid gap-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="grid gap-3 rounded-md border border-line p-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(96px, 1fr))` }}>
          {Array.from({ length: columns }).map((_, columnIndex) => <Skeleton key={columnIndex} className={cn('h-4', columnIndex === 0 && 'h-5')} />)}
        </div>
      ))}
    </div>
  );
}

export function SkeletonArticle() {
  return (
    <main className="bg-white px-5 py-8" role="status" aria-label="Loading">
      <div className="mx-auto grid max-w-5xl gap-6">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-12 w-4/5 max-w-3xl" />
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="aspect-video w-full" />
        <div className="grid gap-3">
          {Array.from({ length: 9 }).map((_, index) => <Skeleton key={index} className={cn('h-4', index % 3 === 2 ? 'w-3/4' : 'w-full')} />)}
        </div>
      </div>
    </main>
  );
}
