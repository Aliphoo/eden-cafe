'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { listPosts, listUsers } from '@/lib/blogRepository';
import type { BlogPost, BlogUser } from '@/lib/types';
import { Badge, Panel } from '@/components/ui';

export default function AuthorPage() {
  const params = useParams<{ id: string }>();
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [users, setUsers] = useState<BlogUser[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([listPosts(false), listUsers()])
      .then(([postRows, userRows]) => {
        setPosts(postRows);
        setUsers(userRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'โหลดบทความไม่สำเร็จ'));
  }, []);

  const author = useMemo(() => users.find((item) => item.id === params.id), [params.id, users]);
  const filtered = useMemo(() => posts.filter((post) => post.author_id === params.id), [params.id, posts]);

  return (
    <main className="px-5 py-10">
      <div className="mx-auto max-w-6xl">
        <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
          <p className="text-sm font-bold text-leaf">Author</p>
          <h1 className="mt-2 text-4xl font-black">{author?.name || filtered[0]?.author_name || 'ผู้เขียน'}</h1>
          {author?.bio && <p className="mt-3 max-w-2xl leading-7 text-[#536159]">{author.bio}</p>}
          {author?.role && <p className="mt-3 text-sm font-bold text-[#66746c]">Role: {author.role}</p>}
        </section>
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {error && <Panel className="border-[#ffd6a6] bg-[#fff8e7] font-bold text-[#8a5a10] md:col-span-2 xl:col-span-3">โหลดบทความจาก Firestore ไม่สำเร็จ: {error}</Panel>}
          {filtered.map((post) => (
            <article key={post.id} className="overflow-hidden rounded-lg border border-line bg-white shadow-panel">
              {post.cover_image_url && <img src={post.cover_image_url} alt={post.cover_image_alt || post.title} className="aspect-video w-full object-cover" />}
              <div className="grid gap-3 p-4">
                <Badge>{post.category_name || post.category_id || 'Blog'}</Badge>
                <h2 className="text-xl font-black"><Link href={`/blog/${post.slug}`}>{post.title}</Link></h2>
                <p className="line-clamp-3 text-sm leading-7 text-[#536159]">{post.excerpt}</p>
              </div>
            </article>
          ))}
          {!filtered.length && <Panel className="md:col-span-2 xl:col-span-3">ยังไม่มีบทความ published จากผู้เขียนนี้</Panel>}
        </div>
      </div>
    </main>
  );
}
