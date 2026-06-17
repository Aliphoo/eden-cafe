'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Archive, Copy, Eye, Pencil, Trash2 } from 'lucide-react';
import { archivePost, deletePost, duplicatePost, listCategories, listPosts } from '@/lib/blogRepository';
import type { BlogPost, Category } from '@/lib/types';
import { Badge, Button, Input, Panel, Select } from '@/components/ui';
import { useAuth } from '@/components/AuthProvider';

export default function PostsPage() {
  const { blogUser } = useAuth();
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('all');
  const [author, setAuthor] = useState('all');
  const [sort, setSort] = useState('updated_at');

  async function reload() {
    const [postRows, categoryRows] = await Promise.all([listPosts(true), listCategories()]);
    setPosts(postRows);
    setCategories(categoryRows);
  }

  useEffect(() => { reload(); }, []);

  const authors = Array.from(new Set(posts.map((post) => post.author_name || post.author_id).filter(Boolean)));
  const filtered = useMemo(() => posts
    .filter((post) => !search || `${post.title} ${post.excerpt}`.toLowerCase().includes(search.toLowerCase()))
    .filter((post) => status === 'all' || post.status === status)
    .filter((post) => category === 'all' || post.category_id === category)
    .filter((post) => author === 'all' || (post.author_name || post.author_id) === author)
    .sort((a, b) => String(b[sort as keyof BlogPost] || '').localeCompare(String(a[sort as keyof BlogPost] || ''))), [author, category, posts, search, sort, status]);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-leaf">บทความทั้งหมด</p>
          <h1 className="text-3xl font-black">จัดการบทความ</h1>
        </div>
        <Link href="/admin/posts/new"><Button>เพิ่มบทความใหม่</Button></Link>
      </div>
      <Panel className="grid gap-3 lg:grid-cols-[1.4fr_.7fr_.8fr_.8fr_.8fr]">
        <Input placeholder="ค้นหาบทความ" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">ทุกสถานะ</option><option value="draft">Draft</option><option value="published">Published</option><option value="scheduled">Scheduled</option><option value="archived">Archived</option>
        </Select>
        <Select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="all">ทุกหมวดหมู่</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Select value={author} onChange={(event) => setAuthor(event.target.value)}>
          <option value="all">ทุกผู้เขียน</option>{authors.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <Select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="created_at">วันที่สร้าง</option><option value="updated_at">วันที่แก้ไข</option><option value="published_at">วันที่เผยแพร่</option>
        </Select>
      </Panel>
      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="text-[#66746c]"><tr><th className="py-2">Cover</th><th>Title</th><th>Status</th><th>Category</th><th>Author</th><th>Published</th><th>Actions</th></tr></thead>
            <tbody>
              {filtered.map((post) => (
                <tr key={post.id} className="border-t border-line">
                  <td className="py-3">{post.cover_image_url ? <img src={post.cover_image_url} alt="" className="h-12 w-16 rounded object-cover" /> : '-'}</td>
                  <td><strong>{post.title}</strong><p className="text-xs text-[#66746c]">/{post.slug}</p></td>
                  <td><Badge tone={post.status === 'published' ? 'green' : post.status === 'scheduled' ? 'blue' : post.status === 'archived' ? 'red' : 'amber'}>{post.status}</Badge></td>
                  <td>{post.category_name || post.category_id || '-'}</td>
                  <td>{post.author_name || '-'}</td>
                  <td>{post.published_at ? new Date(post.published_at).toLocaleDateString('th-TH') : '-'}</td>
                  <td>
                    <div className="flex gap-1">
                      <Link href={`/admin/posts/${post.id}`}><Button variant="ghost"><Pencil size={16} /></Button></Link>
                      <Link href={`/blog/${post.slug}`} target="_blank"><Button variant="ghost"><Eye size={16} /></Button></Link>
                      <Button variant="ghost" onClick={async () => { if (blogUser) { await duplicatePost(post, blogUser); reload(); } }}><Copy size={16} /></Button>
                      <Button variant="ghost" onClick={async () => { await archivePost(post.id); reload(); }}><Archive size={16} /></Button>
                      <Button variant="ghost" onClick={async () => { if (confirm('ลบบทความนี้?')) { await deletePost(post.id); reload(); } }}><Trash2 size={16} /></Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={7} className="py-10 text-center font-bold text-[#66746c]">ยังไม่มีบทความตามเงื่อนไขนี้</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
