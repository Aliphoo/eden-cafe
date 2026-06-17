'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { listCategories, listPosts } from '@/lib/blogRepository';
import type { BlogPost, Category } from '@/lib/types';
import { Badge, Input, Panel } from '@/components/ui';

export default function PublicBlogPage() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([listPosts(false), listCategories()])
      .then(([postRows, categoryRows]) => {
        setPosts(postRows);
        setCategories(categoryRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'โหลดบทความไม่สำเร็จ'));
  }, []);

  const filtered = useMemo(() => posts
    .filter((post) => !search || `${post.title} ${post.excerpt} ${post.tags?.join(' ')}`.toLowerCase().includes(search.toLowerCase()))
    .filter((post) => category === 'all' || post.category_id === category), [category, posts, search]);
  const featured = filtered.find((post) => post.is_featured) || filtered[0];

  return (
    <main>
      <section className="bg-white px-5 py-10">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-bold text-leaf">Eden Cafe Blog</p>
          <h1 className="mt-2 max-w-3xl text-4xl font-black md:text-5xl">บทความ ความรู้ ข่าวสาร และไอเดียสำหรับลูกค้า</h1>
          <div className="mt-6 grid gap-3 md:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-3 text-[#7b8b81]" size={18} />
              <Input className="pl-10" placeholder="Search Blog" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-md border border-line px-3 py-2 text-sm font-bold" onClick={() => setCategory('all')}>ทั้งหมด</button>
              {categories.map((item) => <button key={item.id} className="rounded-md border border-line px-3 py-2 text-sm font-bold" onClick={() => setCategory(item.id)}>{item.name}</button>)}
            </div>
          </div>
        </div>
      </section>
      <section className="px-5 py-8">
        <div className="mx-auto grid max-w-6xl gap-5">
          {error && <Panel className="border-[#ffd6a6] bg-[#fff8e7] font-bold text-[#8a5a10]">โหลดบทความจาก Firestore ไม่สำเร็จ: {error}. ตรวจสอบ Firestore rules สำหรับ public read ของ published posts.</Panel>}
          {featured && (
            <Panel className="grid gap-5 md:grid-cols-[1.1fr_.9fr]">
              {featured.cover_image_url && <img src={featured.cover_image_url} alt={featured.cover_image_alt || featured.title} className="aspect-video h-full w-full rounded-md object-cover" />}
              <div className="grid content-center gap-3">
                <Badge tone="green">{featured.category_name || 'Featured'}</Badge>
                <h2 className="text-3xl font-black"><Link href={`/blog/${featured.slug}`}>{featured.title}</Link></h2>
                <p className="leading-7 text-[#536159]">{featured.excerpt}</p>
                <p className="text-sm font-bold text-[#66746c]">{featured.reading_time} นาทีอ่าน • {featured.published_at ? new Date(featured.published_at).toLocaleDateString('th-TH') : ''}</p>
              </div>
            </Panel>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((post) => (
              <article key={post.id} className="overflow-hidden rounded-lg border border-line bg-white shadow-panel">
                {post.cover_image_url && <img src={post.cover_image_url} alt={post.cover_image_alt || post.title} className="aspect-video w-full object-cover" />}
                <div className="grid gap-3 p-4">
                  <Badge>{post.category_name || post.category_id || 'Blog'}</Badge>
                  <h3 className="text-xl font-black"><Link href={`/blog/${post.slug}`}>{post.title}</Link></h3>
                  <p className="line-clamp-3 text-sm leading-7 text-[#536159]">{post.excerpt}</p>
                  <div className="flex flex-wrap gap-2">{(post.tags || []).map((tag) => <span key={tag} className="text-xs font-bold text-leaf">#{tag}</span>)}</div>
                </div>
              </article>
            ))}
            {!filtered.length && <Panel className="md:col-span-2 xl:col-span-3">ยังไม่มีบทความ published ในระบบ</Panel>}
          </div>
        </div>
      </section>
    </main>
  );
}
