'use client';

import { useEffect, useState } from 'react';
import { listTags, saveTag } from '@/lib/blogRepository';
import type { Tag } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { Button, Field, Input, Panel } from '@/components/ui';

export default function TagsPage() {
  const [rows, setRows] = useState<Tag[]>([]);
  const [name, setName] = useState('');
  async function reload() { setRows(await listTags()); }
  useEffect(() => { reload(); }, []);
  return (
    <div className="grid gap-5">
      <Panel className="grid max-w-xl gap-3">
        <h1 className="text-2xl font-black">Tags</h1>
        <Field label="ชื่อ Tag"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Button onClick={async () => { await saveTag({ name, slug: slugify(name) }); setName(''); reload(); }}>บันทึก Tag</Button>
      </Panel>
      <Panel>
        <div className="flex flex-wrap gap-2">{rows.map((tag) => <span key={tag.id} className="rounded-full border border-line px-3 py-2 text-sm font-bold">{tag.name}</span>)}</div>
      </Panel>
    </div>
  );
}
