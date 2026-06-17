import { doc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { collections } from './blogRepository';
import { nowIso } from './utils';

const categories = [
  ['seo', 'SEO'],
  ['marketing', 'Marketing'],
  ['knowledge', 'Knowledge'],
  ['news', 'News'],
  ['tutorial', 'Tutorial']
];

const tags = ['SEO', 'Blog', 'Content Marketing', 'AEO', 'GEO', 'Website'];

const posts = [
  ['วิธีเขียนบทความ SEO ให้ติด Google', 'seo-writing-google', 'seo'],
  ['Blog สำคัญกับธุรกิจออนไลน์อย่างไร', 'why-blog-matters-online-business', 'marketing'],
  ['วิธีเลือก Keyword สำหรับบทความ', 'keyword-research-for-articles', 'seo'],
  ['การเขียน FAQ ให้เหมาะกับ AEO และ GEO', 'faq-writing-aeo-geo', 'knowledge'],
  ['เทคนิคทำ Internal Link ให้เว็บไซต์แข็งแรงขึ้น', 'internal-link-techniques', 'tutorial']
];

export async function seedBlogCms(actorId: string, actorName: string) {
  await Promise.all(categories.map(([id, name]) => setDoc(doc(db, collections.categories, id), {
    name,
    slug: id,
    description: `หมวด ${name} สำหรับจัดกลุ่มบทความ`,
    cover_image_url: '',
    seo_title: `${name} Blog`,
    seo_description: `รวมบทความหมวด ${name}`,
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso()
  }, { merge: true })));

  await Promise.all(tags.map((name) => setDoc(doc(db, collections.tags, name.toLowerCase().replace(/\s+/g, '-')), {
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    created_at: nowIso(),
    updated_at: nowIso()
  }, { merge: true })));

  await Promise.all(posts.map(([title, slug, category], index) => setDoc(doc(db, collections.posts, slug), {
    title,
    slug,
    excerpt: `ตัวอย่างบทความสำหรับระบบ Blog CMS: ${title}`,
    content: `<h2>สรุปคำตอบ</h2><p>${title} ควรเริ่มจากเป้าหมายของผู้อ่าน คำค้นหา และโครงสร้างเนื้อหาที่ตอบคำถามได้ชัดเจน</p><h2>แนวทางใช้งานจริง</h2><p>กำหนดหัวข้อย่อย ใส่ตัวอย่างที่เกี่ยวกับธุรกิจ และปิดท้ายด้วย CTA ที่พาผู้อ่านไปยังหน้าที่เหมาะสม</p><h3>FAQ</h3><p>บทความควรมีคำถามที่ลูกค้ามักถาม เพื่อช่วยทั้ง SEO, AEO และ GEO</p>`,
    cover_image_url: '/Hero/Hero.webp',
    cover_image_alt: title,
    cover_image_caption: 'Eden Cafe Blog',
    status: index < 3 ? 'published' : 'draft',
    author_id: actorId,
    author_name: actorName,
    category_id: category,
    category_name: categories.find(([id]) => id === category)?.[1] || '',
    tag_ids: ['seo', 'blog'],
    tags: ['SEO', 'Blog'],
    seo_title: title,
    seo_description: `อ่าน${title} พร้อมแนวทางทำบทความให้เหมาะกับ SEO, AEO และ GEO`,
    focus_keyword: title.split(' ')[0],
    canonical_url: '',
    og_title: title,
    og_description: `ตัวอย่าง ${title}`,
    og_image_url: '/Hero/Hero.webp',
    twitter_title: title,
    twitter_description: `ตัวอย่าง ${title}`,
    twitter_image_url: '/Hero/Hero.webp',
    robots_index: true,
    robots_follow: true,
    schema_type: 'BlogPosting',
    brand_context: 'Eden Cafe ใช้บทความเพื่อให้ความรู้และเชื่อมลูกค้ากับประสบการณ์หน้าร้าน',
    business_context: 'Eden Cafe เชียงราย คาเฟ่ธรรมชาติพร้อมอาหาร เครื่องดื่ม และกิจกรรม',
    faqs: [{ question: `ควรเริ่ม ${title} อย่างไร`, answer: 'เริ่มจากคำถามหลักของผู้อ่าน แล้ววางโครง H2/H3 ให้ตอบได้เป็นลำดับ' }],
    reading_time: 2,
    word_count: 420,
    is_featured: index === 0,
    published_at: index < 3 ? nowIso() : '',
    scheduled_at: '',
    created_at: nowIso(),
    updated_at: nowIso()
  }, { merge: true })));
}
