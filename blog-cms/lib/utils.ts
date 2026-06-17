import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { BlogPost, ChecklistState } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function htmlToText(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function countWords(html: string) {
  const text = htmlToText(html);
  const thaiChunks = (text.match(/[\u0E00-\u0E7F]+/g) || []).join('').length;
  const latinWords = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return Math.max(latinWords + Math.ceil(thaiChunks / 5), 0);
}

export function readingTime(wordCount: number) {
  return Math.max(1, Math.ceil(wordCount / 220));
}

export function nowIso() {
  return new Date().toISOString();
}

export function toDoc<T extends { id: string }>(id: string, data: Record<string, unknown>): T {
  return { id, ...data } as T;
}

export function seoChecklist(post: Partial<BlogPost>) {
  const content = post.content || '';
  const text = htmlToText(content);
  const hasImageWithoutAlt = /<img\b(?![^>]*alt=["'][^"']+["'])/i.test(content);
  const items: Array<{ label: string; state: ChecklistState }> = [
    { label: 'มี Focus Keyword', state: post.focus_keyword ? 'ผ่าน' : 'ยังไม่ได้ทำ' },
    { label: 'SEO Title ไม่ยาวเกินไป', state: post.seo_title ? (post.seo_title.length <= 60 ? 'ผ่าน' : 'ควรปรับปรุง') : 'ยังไม่ได้ทำ' },
    { label: 'Meta Description พร้อมใช้งาน', state: post.seo_description ? (post.seo_description.length <= 160 ? 'ผ่าน' : 'ควรปรับปรุง') : 'ยังไม่ได้ทำ' },
    { label: 'Slug อ่านง่าย', state: post.slug && /^[\p{L}\p{N}-]+$/u.test(post.slug) ? 'ผ่าน' : 'ยังไม่ได้ทำ' },
    { label: 'มี H2/H3 สำหรับโครงบทความ', state: /<h[23]/i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง' },
    { label: 'รูปภาพมี Alt Text', state: hasImageWithoutAlt ? 'ควรปรับปรุง' : (post.cover_image_alt ? 'ผ่าน' : 'ยังไม่ได้ทำ') },
    { label: 'มี Internal Link', state: /href=["']\//i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง' },
    { label: 'มี External Link', state: /href=["']https?:\/\//i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง' },
    { label: 'มี FAQ/AEO Block', state: (post.faqs || []).length ? 'ผ่าน' : 'ควรปรับปรุง' },
    { label: 'ความยาวบทความเหมาะสม', state: countWords(content) >= 600 ? 'ผ่าน' : 'ควรปรับปรุง' },
    { label: 'มี CTA', state: /cta|ติดต่อ|จอง|สอบถาม|สมัคร|ซื้อ|อ่านต่อ/i.test(text) ? 'ผ่าน' : 'ควรปรับปรุง' }
  ];
  return items;
}

export function buildJsonLd(post: BlogPost, siteUrl = 'https://www.edencafe.co') {
  const url = `${siteUrl.replace(/\/$/, '')}/blog/${post.slug}`;
  const graph: Record<string, unknown>[] = [
    {
      '@type': post.schema_type || 'BlogPosting',
      '@id': `${url}#article`,
      headline: post.seo_title || post.title,
      description: post.seo_description || post.excerpt,
      image: post.og_image_url || post.cover_image_url,
      datePublished: post.published_at,
      dateModified: post.updated_at,
      author: { '@type': 'Person', name: post.author_name || 'Eden Cafe' },
      mainEntityOfPage: url
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Blog', item: `${siteUrl.replace(/\/$/, '')}/blog` },
        { '@type': 'ListItem', position: 2, name: post.title, item: url }
      ]
    }
  ];

  if (post.faqs?.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: post.faqs.map((faq) => ({
        '@type': 'Question',
        name: faq.question,
        acceptedAnswer: { '@type': 'Answer', text: faq.answer }
      }))
    });
  }

  if (post.business_context) {
    graph.push({
      '@type': 'LocalBusiness',
      name: 'Eden Cafe',
      description: post.business_context
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}
