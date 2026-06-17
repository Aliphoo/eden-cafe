'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { Bold, Heading2, Heading3, ImageIcon, Italic, LinkIcon, List, ListOrdered, Quote, Save, Send, Sparkles } from 'lucide-react';
import { archivePost, listCategories, listTags, saveCategory, savePost, saveTag, uploadMedia } from '@/lib/blogRepository';
import type { BlogPost, Category, FaqItem, Tag } from '@/lib/types';
import { countWords, readingTime, seoChecklist, slugify } from '@/lib/utils';
import { useAuth } from './AuthProvider';
import { Badge, Button, Field, Input, Panel, Select, Textarea } from './ui';

type Props = { initial?: BlogPost | null };

const blankPost: Partial<BlogPost> = {
  title: '',
  slug: '',
  excerpt: '',
  content: '',
  status: 'draft',
  tag_ids: [],
  tags: [],
  faqs: [],
  robots_index: true,
  robots_follow: true,
  schema_type: 'BlogPosting',
  is_featured: false
};

export function PostEditor({ initial }: Props) {
  const router = useRouter();
  const { blogUser, canPublish } = useAuth();
  const [post, setPost] = useState<Partial<BlogPost>>({ ...blankPost, ...initial });
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState('');
  const [error, setError] = useState('');
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Image,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: 'เขียนบทความ ใส่ H2/H3, FAQ, CTA และลิงก์ภายในได้ที่นี่...' }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell
    ],
    content: post.content || '',
    immediatelyRender: false,
    onUpdate: ({ editor: activeEditor }) => {
      const content = activeEditor.getHTML();
      setPost((current) => ({
        ...current,
        content,
        word_count: countWords(content),
        reading_time: readingTime(countWords(content))
      }));
    }
  });

  useEffect(() => {
    Promise.all([listCategories(), listTags()]).then(([catRows, tagRows]) => {
      setCategories(catRows);
      setTags(tagRows);
    });
  }, []);

  useEffect(() => {
    if (!blogUser || !post.title) return;
    const timer = window.setTimeout(async () => {
      try {
        const id = await savePost({ ...post, status: post.status || 'draft' }, blogUser);
        setPost((current) => ({ ...current, id }));
        setLastSaved(new Date().toLocaleTimeString('th-TH'));
      } catch {
        // Autosave stays quiet; explicit save shows errors.
      }
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [blogUser, post]);

  const words = useMemo(() => countWords(post.content || ''), [post.content]);
  const checklist = useMemo(() => seoChecklist(post), [post]);
  const toc = useMemo(() => Array.from((post.content || '').matchAll(/<h([23])[^>]*>(.*?)<\/h[23]>/gi)).map((match) => match[2].replace(/<[^>]+>/g, '')), [post.content]);

  function update<K extends keyof BlogPost>(key: K, value: BlogPost[K]) {
    setPost((current) => ({ ...current, [key]: value }));
  }

  async function doSave(status = post.status || 'draft') {
    if (!blogUser) return;
    if ((status === 'published' || status === 'scheduled') && !canPublish) {
      setError('Writer สามารถบันทึก Draft ได้เท่านั้น');
      return;
    }
    if (status === 'published' && (!post.category_id || !post.content)) {
      setError('ก่อน Publish ต้องมีหมวดหมู่และเนื้อหา');
      return;
    }
    if (status === 'scheduled' && !post.scheduled_at) {
      setError('กรุณาใส่วันเวลา Schedule');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const id = await savePost({ ...post, status }, blogUser);
      setPost((current) => ({ ...current, id, status }));
      setLastSaved(new Date().toLocaleTimeString('th-TH'));
      router.replace(`/admin/posts/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function onImage(file: File) {
    if (!blogUser) return;
    const asset = await uploadMedia(file, blogUser, { alt_text: post.cover_image_alt || post.title });
    update('cover_image_url', asset.url);
  }

  async function addCategory(name: string) {
    const id = await saveCategory({ name, slug: slugify(name), is_active: true });
    setCategories(await listCategories());
    update('category_id', id);
    update('category_name', name);
  }

  async function addTag(name: string) {
    const id = await saveTag({ name, slug: slugify(name) });
    setTags(await listTags());
    setPost((current) => ({ ...current, tag_ids: [...(current.tag_ids || []), id], tags: [...(current.tags || []), name] }));
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid gap-4">
        <Panel className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Badge tone={post.status === 'published' ? 'green' : post.status === 'scheduled' ? 'blue' : 'amber'}>{post.status || 'draft'}</Badge>
              <p className="mt-2 text-sm text-[#66746c]">{lastSaved ? `บันทึกล่าสุดเมื่อ ${lastSaved}` : 'Autosave ทุก 12 วินาทีหลังเริ่มเขียน'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setPreviewMode(previewMode === 'desktop' ? 'mobile' : 'desktop')}>Preview {previewMode === 'desktop' ? 'Mobile' : 'Desktop'}</Button>
              <Button variant="secondary" disabled={saving} onClick={() => doSave('draft')}><Save size={16} /> Save Draft</Button>
              <Button disabled={saving || !canPublish} onClick={() => doSave('published')}><Send size={16} /> Publish</Button>
            </div>
          </div>
          {error && <div className="rounded-md border border-[#ffc7c7] bg-[#fff1f1] p-3 text-sm font-bold text-[#a12d2d]">{error}</div>}
          <Input
            value={post.title || ''}
            onChange={(event) => {
              const title = event.target.value;
              setPost((current) => ({ ...current, title, slug: current.slug || slugify(title) }));
            }}
            placeholder="ชื่อบทความ"
            className="min-h-14 text-2xl font-black"
          />
          <Input value={post.slug || ''} onChange={(event) => update('slug', slugify(event.target.value))} placeholder="url-slug" />
        </Panel>

        <Panel>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></Button>
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></Button>
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></Button>
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></Button>
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></Button>
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></Button>
            <Button variant="ghost" onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16} /></Button>
            <Button variant="ghost" onClick={() => {
              const url = prompt('URL');
              if (url) editor?.chain().focus().setLink({ href: url }).run();
            }}><LinkIcon size={16} /></Button>
            <Button variant="ghost" onClick={() => document.getElementById('inline-image-input')?.click()}><ImageIcon size={16} /></Button>
            <input id="inline-image-input" className="hidden" type="file" accept="image/*" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file || !blogUser) return;
              const asset = await uploadMedia(file, blogUser, { alt_text: post.title });
              editor?.chain().focus().setImage({ src: asset.url, alt: post.title }).run();
            }} />
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <EditorContent editor={editor} />
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-sm font-bold text-[#66746c]">
            <span>{words} words</span>
            <span>{readingTime(words)} นาทีอ่าน</span>
            <span>{toc.length} headings ใน TOC</span>
          </div>
        </Panel>

        <Panel className={previewMode === 'mobile' ? 'mx-auto max-w-sm' : ''}>
          <p className="mb-3 text-sm font-black text-leaf">Preview</p>
          <article className="cms-prose">
            <h1 className="text-3xl font-black">{post.title || 'Untitled'}</h1>
            <p>{post.excerpt}</p>
            {post.cover_image_url && <img src={post.cover_image_url} alt={post.cover_image_alt || post.title || ''} />}
            <div dangerouslySetInnerHTML={{ __html: post.content || '' }} />
          </article>
        </Panel>
      </div>

      <aside className="grid content-start gap-4">
        <Panel className="grid gap-3">
          <h2 className="font-black">Publish Settings</h2>
          <Field label="Status">
            <Select value={post.status} onChange={(event) => update('status', event.target.value as BlogPost['status'])}>
              <option value="draft">Draft</option>
              <option value="published" disabled={!canPublish}>Published</option>
              <option value="scheduled" disabled={!canPublish}>Scheduled</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          <Field label="Schedule Date">
            <Input type="datetime-local" value={post.scheduled_at || ''} onChange={(event) => update('scheduled_at', event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={post.robots_index ?? true} onChange={(event) => update('robots_index', event.target.checked)} /> Allow Indexing</label>
          <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={post.is_featured ?? false} onChange={(event) => update('is_featured', event.target.checked)} /> Featured Post</label>
          {post.id && <Button variant="danger" onClick={async () => { await archivePost(post.id!); router.push('/admin/posts'); }}>Archive</Button>}
        </Panel>

        <Panel className="grid gap-3">
          <h2 className="font-black">Category & Tags</h2>
          <Field label="Category">
            <Select value={post.category_id || ''} onChange={(event) => {
              const category = categories.find((item) => item.id === event.target.value);
              update('category_id', event.target.value);
              update('category_name', category?.name || '');
            }}>
              <option value="">เลือกหมวดหมู่</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </Select>
          </Field>
          <Button variant="secondary" onClick={() => { const name = prompt('ชื่อหมวดหมู่ใหม่'); if (name) addCategory(name); }}>เพิ่ม Category</Button>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <button key={tag.id} className="rounded-full border border-line px-3 py-1 text-sm font-bold" onClick={() => setPost((current) => ({
                ...current,
                tag_ids: Array.from(new Set([...(current.tag_ids || []), tag.id])),
                tags: Array.from(new Set([...(current.tags || []), tag.name]))
              }))}>{tag.name}</button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => { const name = prompt('ชื่อ Tag ใหม่'); if (name) addTag(name); }}>เพิ่ม Tag</Button>
        </Panel>

        <Panel className="grid gap-3">
          <h2 className="font-black">Cover Image</h2>
          {post.cover_image_url && <img className="aspect-video w-full rounded-md object-cover" src={post.cover_image_url} alt={post.cover_image_alt || ''} />}
          <Input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImage(file); }} />
          <Input value={post.cover_image_url || ''} onChange={(event) => update('cover_image_url', event.target.value)} placeholder="Image URL" />
          <Input value={post.cover_image_alt || ''} onChange={(event) => update('cover_image_alt', event.target.value)} placeholder="Alt Text" />
          <Input value={post.cover_image_caption || ''} onChange={(event) => update('cover_image_caption', event.target.value)} placeholder="Caption" />
        </Panel>

        <Panel className="grid gap-3">
          <h2 className="font-black">SEO / AEO / GEO</h2>
          <Input value={post.focus_keyword || ''} onChange={(event) => update('focus_keyword', event.target.value)} placeholder="Focus Keyword" />
          <Input value={post.seo_title || ''} onChange={(event) => update('seo_title', event.target.value)} placeholder="SEO Title" />
          <Textarea value={post.seo_description || ''} onChange={(event) => update('seo_description', event.target.value)} placeholder="Meta Description" />
          <Input value={post.canonical_url || ''} onChange={(event) => update('canonical_url', event.target.value)} placeholder="Canonical URL" />
          <Select value={post.schema_type || 'BlogPosting'} onChange={(event) => update('schema_type', event.target.value as BlogPost['schema_type'])}>
            {['Article', 'BlogPosting', 'FAQPage', 'LocalBusiness', 'Organization', 'Product'].map((type) => <option key={type}>{type}</option>)}
          </Select>
          <Textarea value={post.brand_context || ''} onChange={(event) => update('brand_context', event.target.value)} placeholder="Brand Context สำหรับ GEO" />
          <Textarea value={post.business_context || ''} onChange={(event) => update('business_context', event.target.value)} placeholder="ข้อมูลธุรกิจ: ชื่อร้าน ที่อยู่ เวลาเปิด เบอร์โทร พื้นที่ให้บริการ" />
          <Button variant="secondary" onClick={() => {
            const question = prompt('คำถาม FAQ');
            const answer = question ? prompt('คำตอบ') : '';
            if (question && answer) update('faqs', [...(post.faqs || []), { question, answer } as FaqItem]);
          }}>เพิ่ม FAQ Block</Button>
        </Panel>

        <Panel>
          <h2 className="mb-3 font-black">SEO Checklist</h2>
          <div className="grid gap-2">
            {checklist.map((item) => <div key={item.label} className="flex items-center justify-between gap-3 text-sm"><span>{item.label}</span><Badge tone={item.state === 'ผ่าน' ? 'green' : item.state === 'ควรปรับปรุง' ? 'amber' : 'red'}>{item.state}</Badge></div>)}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-3 flex items-center gap-2 font-black"><Sparkles size={18} /> AI Blog Assistant</h2>
          <div className="grid gap-2">
            {['Generate Blog Outline', 'Generate SEO Title', 'Generate Meta Description', 'Generate FAQ', 'Rewrite Paragraph', 'Improve SEO', 'Generate CTA', 'Suggest Tags'].map((label) => (
              <Button key={label} variant="secondary" onClick={() => alert(`Prompt Template: ${label}\n\nเชื่อม OpenAI API หรือ workflow ภายในได้จากปุ่มนี้`)}>{label}</Button>
            ))}
          </div>
        </Panel>
      </aside>
    </div>
  );
}
