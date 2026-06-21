'use client';

import { useEffect, useState } from 'react';
import { listCategories, saveCategory } from '@/lib/blogRepository';
import type { Category } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { Button, Field, Input, Panel, Skeleton, Textarea } from '@/components/ui';

export default function CategoriesPage() {
  const [rows, setRows] = useState<Category[]>([]);
  const [form, setForm] = useState<Partial<Category>>({ name: '', slug: '', is_active: true });
  const [loading, setLoading] = useState(true);
  async function reload() {
    setLoading(true);
    try {
      setRows(await listCategories());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);
  return (
    <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
      <Panel className="grid gap-3">
        <h1 className="text-2xl font-black">หมวดหมู่บทความ</h1>
        <Field label="ชื่อหมวดหมู่"><Input value={form.name || ''} onChange={(event) => setForm({ ...form, name: event.target.value, slug: slugify(event.target.value) })} /></Field>
        <Field label="Slug"><Input value={form.slug || ''} onChange={(event) => setForm({ ...form, slug: slugify(event.target.value) })} /></Field>
        <Field label="Description"><Textarea value={form.description || ''} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        <Field label="SEO Title"><Input value={form.seo_title || ''} onChange={(event) => setForm({ ...form, seo_title: event.target.value })} /></Field>
        <Field label="SEO Description"><Textarea value={form.seo_description || ''} onChange={(event) => setForm({ ...form, seo_description: event.target.value })} /></Field>
        <Button onClick={async () => { await saveCategory(form); setForm({ name: '', slug: '', is_active: true }); reload(); }}>บันทึกหมวดหมู่</Button>
      </Panel>
      <Panel>
        <div className="grid gap-2">
          {loading ? (
            Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-16 w-full" />)
          ) : rows.map((row) => <button key={row.id} className="rounded-md border border-line p-3 text-left" onClick={() => setForm(row)}><strong>{row.name}</strong><p className="text-sm text-[#66746c]">/{row.slug}</p></button>)}
        </div>
      </Panel>
    </div>
  );
}
