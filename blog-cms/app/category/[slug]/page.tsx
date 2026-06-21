'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { listCategories, listPosts } from '@/lib/blogRepository';
import type { BlogPost, Category } from '@/lib/types';
import { Badge, Panel, SkeletonGrid } from '@/components/ui';

export default function CategoryPage() {
  const params = useParams<{ slug: string }>();
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([listPosts(false), listCategories()])
      .then(([postRows, categoryRows]) => {
        setPosts(postRows);
        setCategories(categoryRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'โหลดบทความไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  const category = useMemo(() => categories.find((item) => item.slug === params.slug || item.id === params.slug), [categories, params.slug]);
  const filtered = useMemo(() => posts.filter((post) => post.category_id === category?.id || post.category_id === params.slug), [category, params.slug, posts]);

  return (
    <main className="px-5 py-10">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-bold text-leaf">Category</p>
        <h1 className="mt-2 text-4xl font-black">{category?.name || params.slug}</h1>
        {category?.description && <p className="mt-3 max-w-2xl leading-7 text-[#536159]">{category.description}</p>}
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {loading && <SkeletonGrid className="md:col-span-2 xl:col-span-3" count={6} />}
          {!loading && error && <Panel className="border-[#ffd6a6] bg-[#fff8e7] font-bold text-[#8a5a10] md:col-span-2 xl:col-span-3">โหลดบทความจาก Firestore ไม่สำเร็จ: {error}</Panel>}
          {filtered.map((post) => (
            <article key={post.id} className="overflow-hidden rounded-lg border border-line bg-white shadow-panel">
              {post.cover_image_url && <img src={post.cover_image_url} alt={post.cover_image_alt || post.title} className="aspect-video w-full object-cover" />}
              <div className="grid gap-3 p-4">
                <Badge>{post.category_name || category?.name || 'Blog'}</Badge>
                <h2 className="text-xl font-black"><Link href={`/blog/${post.slug}`}>{post.title}</Link></h2>
                <p className="line-clamp-3 text-sm leading-7 text-[#536159]">{post.excerpt}</p>
              </div>
            </article>
          ))}
          {!loading && !filtered.length && <Panel className="md:col-span-2 xl:col-span-3">ยังไม่มีบทความ published ในหมวดนี้</Panel>}
        </div>
      </div>
    </main>
  );
}
