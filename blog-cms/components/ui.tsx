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
