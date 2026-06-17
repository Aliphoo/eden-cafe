'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, FileText, Image, Send, Timer, Wand2, type LucideIcon } from 'lucide-react';
import { listCategories, listPosts } from '@/lib/blogRepository';
import type { BlogPost, Category } from '@/lib/types';
import { seoChecklist } from '@/lib/utils';
import { Badge, Button, Panel } from '@/components/ui';

export default function AdminDashboard() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([listPosts(true), listCategories()]).then(([postRows, categoryRows]) => {
      setPosts(postRows);
      setCategories(categoryRows);
      setLoading(false);
    });
  }, []);

  const stats = useMemo(() => ({
    all: posts.length,
    draft: posts.filter((post) => post.status === 'draft').length,
    published: posts.filter((post) => post.status === 'published').length,
    scheduled: posts.filter((post) => post.status === 'scheduled').length,
    missingSeo: posts.filter((post) => seoChecklist(post).some((item) => item.state !== 'ผ่าน')).length,
    missingCover: posts.filter((post) => !post.cover_image_url).length,
    missingMeta: posts.filter((post) => !post.seo_description).length
  }), [posts]);

  if (loading) return <p className="font-bold">กำลังโหลด Dashboard...</p>;

  const statCards: Array<[string, number, LucideIcon]> = [
    ['บทความทั้งหมด', stats.all, FileText],
    ['Draft', stats.draft, Wand2],
    ['Published', stats.published, Send],
    ['Scheduled', stats.scheduled, Timer],
    ['หมวดหมู่', categories.length, FileText]
  ];

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-leaf">ภาพรวม Blog</p>
          <h1 className="text-3xl font-black">Dashboard หลังบ้าน</h1>
        </div>
        <Link href="/admin/posts/new"><Button>เพิ่มบทความใหม่</Button></Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {statCards.map(([label, value, Icon]) => (
          <Panel key={String(label)} className="min-h-32">
            <Icon className="text-leaf" size={22} />
            <strong className="mt-5 block text-3xl">{String(value)}</strong>
            <span className="text-sm font-bold text-[#637269]">{String(label)}</span>
          </Panel>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <Panel>
          <h2 className="mb-3 text-lg font-black">บทความล่าสุด</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-[#66746c]">
                <tr><th className="py-2">Title</th><th>Status</th><th>Category</th><th>SEO</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {posts.slice(0, 8).map((post) => (
                  <tr key={post.id} className="border-t border-line">
                    <td className="py-3 font-bold"><Link href={`/admin/posts/${post.id}`}>{post.title}</Link></td>
                    <td><Badge tone={post.status === 'published' ? 'green' : post.status === 'scheduled' ? 'blue' : 'amber'}>{post.status}</Badge></td>
                    <td>{post.category_name || post.category_id || '-'}</td>
                    <td>{seoChecklist(post).filter((item) => item.state === 'ผ่าน').length}/11</td>
                    <td>{post.updated_at ? new Date(post.updated_at).toLocaleDateString('th-TH') : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-black"><AlertTriangle size={18} /> งานที่ควรตรวจ</h2>
          <div className="grid gap-3">
            <div className="rounded-md bg-[#fff8e7] p-3"><strong>{stats.missingSeo}</strong> บทความที่ SEO ยังไม่ครบ</div>
            <div className="rounded-md bg-[#fff1f1] p-3"><strong>{stats.missingCover}</strong> บทความที่ไม่มี Cover Image</div>
            <div className="rounded-md bg-[#eef5ff] p-3"><strong>{stats.missingMeta}</strong> บทความที่ไม่มี Meta Description</div>
            <Link href="/admin/media"><Button variant="secondary" className="w-full"><Image size={16} /> เปิด Media Library</Button></Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
