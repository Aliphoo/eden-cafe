'use client';

import { useEffect, useState } from 'react';
import { Copy, Trash2, Upload } from 'lucide-react';
import { deleteMedia, listMedia, uploadMedia } from '@/lib/blogRepository';
import type { MediaAsset } from '@/lib/types';
import { useAuth } from '@/components/AuthProvider';
import { Button, Input, Panel, SkeletonGrid } from '@/components/ui';

export default function MediaPage() {
  const { blogUser } = useAuth();
  const [rows, setRows] = useState<MediaAsset[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  async function reload() {
    setLoading(true);
    try {
      setRows(await listMedia());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);
  const filtered = rows.filter((row) => !search || `${row.filename} ${row.alt_text}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="grid gap-5">
      <div>
        <p className="text-sm font-bold text-leaf">Media Library</p>
        <h1 className="text-3xl font-black">จัดการรูปภาพ</h1>
      </div>
      <Panel className="grid gap-3 md:grid-cols-[1fr_auto]">
        <Input placeholder="ค้นหารูปภาพ" value={search} onChange={(event) => setSearch(event.target.value)} />
        <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-leaf px-4 py-2 text-sm font-bold text-white">
          <Upload size={16} /> Upload Image
          <input className="hidden" type="file" accept="image/*" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file && blogUser) { await uploadMedia(file, blogUser); reload(); }
          }} />
        </label>
      </Panel>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {loading ? <SkeletonGrid className="md:col-span-2 xl:col-span-4 md:grid-cols-2 xl:grid-cols-4" count={8} lines={2} /> : filtered.map((asset) => (
          <Panel key={asset.id} className="grid gap-3">
            <img src={asset.url} alt={asset.alt_text || asset.filename} className="aspect-video w-full rounded-md object-cover" />
            <strong className="break-all text-sm">{asset.filename}</strong>
            <p className="text-xs text-[#66746c]">{Math.round(asset.size / 1024)} KB • {asset.mime_type}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => navigator.clipboard.writeText(asset.url)}><Copy size={16} /></Button>
              <Button variant="danger" onClick={async () => { if (confirm('ลบรูปนี้?')) { await deleteMedia(asset); reload(); } }}><Trash2 size={16} /></Button>
            </div>
          </Panel>
        ))}
        {!loading && !filtered.length && <Panel className="md:col-span-2 xl:col-span-4">ยังไม่มีรูปภาพ</Panel>}
      </div>
    </div>
  );
}
