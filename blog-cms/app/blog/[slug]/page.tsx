'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Facebook, LinkIcon } from 'lucide-react';
import { getPostBySlug, listPosts } from '@/lib/blogRepository';
import type { BlogPost } from '@/lib/types';
import { buildJsonLd } from '@/lib/utils';
import { Badge, Button, Panel } from '@/components/ui';

export default function PublicPostPage() {
  const params = useParams<{ slug: string }>();
  const [post, setPost] = useState<BlogPost | null | undefined>(undefined);
  const [allPosts, setAllPosts] = useState<BlogPost[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    getPostBySlug(params.slug).then(setPost).catch((err) => {
      setError(err instanceof Error ? err.message : 'โหลดบทความไม่สำเร็จ');
      setPost(null);
    });
    listPosts(false).then(setAllPosts).catch(() => setAllPosts([]));
  }, [params.slug]);

  const toc = useMemo(() => Array.from((post?.content || '').matchAll(/<h([23])[^>]*>(.*?)<\/h[23]>/gi)).map((match) => match[2].replace(/<[^>]+>/g, '')), [post]);
  const related = post ? allPosts.filter((item) => item.id !== post.id && (item.category_id === post.category_id || item.tag_ids?.some((tag) => post.tag_ids?.includes(tag)))).slice(0, 3) : [];
  const index = post ? allPosts.findIndex((item) => item.id === post.id) : -1;
  const previous = index > 0 ? allPosts[index - 1] : null;
  const next = index >= 0 ? allPosts[index + 1] : null;

  if (post === undefined) return <main className="grid min-h-screen place-items-center font-bold">กำลังโหลดบทความ...</main>;
  if (error) return <main className="grid min-h-screen place-items-center p-5"><Panel className="max-w-xl border-[#ffd6a6] bg-[#fff8e7] font-bold text-[#8a5a10]">โหลดบทความจาก Firestore ไม่สำเร็จ: {error}. ตรวจสอบ Firestore rules สำหรับ public read ของ published posts.</Panel></main>;
  if (!post || post.status !== 'published') return <main className="grid min-h-screen place-items-center font-bold">ไม่พบบทความ</main>;

  return (
    <main className="bg-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(buildJsonLd(post, process.env.NEXT_PUBLIC_SITE_URL)) }} />
      <article>
        <header className="px-5 py-8">
          <div className="mx-auto max-w-4xl">
            <nav className="mb-5 text-sm font-bold text-[#66746c]"><Link href="/blog">Blog</Link> / {post.category_name || post.category_id}</nav>
            <Badge tone="green">{post.category_name || 'Blog'}</Badge>
            <h1 className="mt-4 text-4xl font-black md:text-5xl">{post.title}</h1>
            <p className="mt-4 text-lg leading-8 text-[#536159]">{post.excerpt}</p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm font-bold text-[#66746c]">
              <span>{post.author_name || 'Eden Cafe'}</span>
              <span>{post.reading_time} นาทีอ่าน</span>
              <span>{post.published_at ? new Date(post.published_at).toLocaleDateString('th-TH') : ''}</span>
              {post.updated_at && <span>Updated {new Date(post.updated_at).toLocaleDateString('th-TH')}</span>}
            </div>
          </div>
        </header>
        {post.cover_image_url && <div className="mx-auto max-w-5xl px-5"><img src={post.cover_image_url} alt={post.cover_image_alt || post.title} className="aspect-video w-full rounded-lg object-cover" /></div>}
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-8 lg:grid-cols-[240px_1fr]">
          <aside className="hidden lg:block">
            <Panel className="sticky top-5">
              <h2 className="mb-3 font-black">Table of Contents</h2>
              <div className="grid gap-2 text-sm text-[#536159]">{toc.map((item) => <span key={item}>{item}</span>)}</div>
              <div className="mt-5 grid gap-2">
                <Button variant="secondary" onClick={() => navigator.clipboard.writeText(window.location.href)}><LinkIcon size={16} /> Copy URL</Button>
                <Button variant="secondary"><Facebook size={16} /> Share</Button>
              </div>
            </Panel>
          </aside>
          <div>
            <div className="cms-prose" dangerouslySetInnerHTML={{ __html: post.content }} />
            {post.faqs?.length > 0 && (
              <Panel className="mt-8">
                <h2 className="text-2xl font-black">FAQ</h2>
                <div className="mt-4 grid gap-4">{post.faqs.map((faq) => <div key={faq.question}><strong>{faq.question}</strong><p className="mt-1 leading-7 text-[#536159]">{faq.answer}</p></div>)}</div>
              </Panel>
            )}
            <Panel className="mt-8">
              <h2 className="text-xl font-black">Author Box</h2>
              <p className="mt-2 text-[#536159]">{post.author_name || 'Eden Cafe'} เขียนบทความนี้เพื่อช่วยให้ผู้อ่านเข้าใจหัวข้อและนำไปใช้ได้จริง</p>
            </Panel>
            <div className="mt-8 flex flex-wrap justify-between gap-3">
              {previous && <Link href={`/blog/${previous.slug}`}><Button variant="secondary">Previous: {previous.title}</Button></Link>}
              {next && <Link href={`/blog/${next.slug}`}><Button variant="secondary">Next: {next.title}</Button></Link>}
            </div>
            {!!related.length && (
              <section className="mt-10">
                <h2 className="text-2xl font-black">Related Posts</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-3">{related.map((item) => <Link className="rounded-md border border-line p-4 font-bold" key={item.id} href={`/blog/${item.slug}`}>{item.title}</Link>)}</div>
              </section>
            )}
          </div>
        </div>
      </article>
    </main>
  );
}
