# Eden Blog CMS

Next.js + TypeScript Blog CMS สำหรับ Eden Cafe พร้อมหลังบ้านภาษาไทย, Firebase Auth, Firestore database, Storage media library, public blog pages, SEO/AEO/GEO fields และ seed data ตัวอย่าง

## Quick Start

```bash
cd "D:\Eden Cafe Website\blog-cms"
npm install
copy .env.example .env.local
npm run dev
```

เปิด `http://localhost:3010/admin` แล้ว login ด้วย Google

## Firebase Setup

ระบบใช้ Firebase project `edencafe-d9095` เป็นค่า default ใน `.env.example` แล้ว แต่ production ควรใช้ `.env.local`

Required services:

- Authentication: เปิด Google provider
- Firestore Database: ใช้ collections ด้านล่าง
- Firebase Storage: ใช้เก็บ cover image และรูปใน editor

Rules templates are included:

- `firestore-blog-cms.rules.example`
- `storage-blog-cms.rules.example`

ตรวจ rules template ก่อนนำไปรวมกับ root Firebase rules ของเว็บไซต์จริง เพราะ repo หลักมี production rules เดิมอยู่แล้ว

หลัง login ครั้งแรก ระบบจะอ่าน role จาก collection `blog_users` โดย document id ต้องเป็น Firebase Auth UID

ตัวอย่าง document:

```json
{
  "name": "Eden Admin",
  "email": "admin@example.com",
  "avatar_url": "",
  "bio": "ผู้ดูแล Blog",
  "role": "admin",
  "created_at": "2026-06-17T00:00:00.000Z",
  "updated_at": "2026-06-17T00:00:00.000Z"
}
```

Roles:

- `admin`: จัดการได้ทุกอย่าง
- `editor`: เขียน แก้ไข และ publish ได้
- `writer`: เขียนและบันทึก draft ได้ แต่ publish ไม่ได้

## Collections

- `blog_users`
- `blogs`
- `blog_categories`
- `blog_tags`
- `blog_media_assets`
- `blog_revisions`
- `blog_settings`

Post fields include title, slug, excerpt, content, cover image, status, author, category, tags, SEO title/description, canonical URL, OG/Twitter fields, robots flags, schema type, FAQ, brand/business context, reading time, word count, featured flag, publish/schedule dates, created/updated dates.

## Seed Data

เข้า `/admin/seed` แล้วกด `Run Seed`

Seed จะสร้าง:

- 5 posts ตัวอย่าง
- categories: SEO, Marketing, Knowledge, News, Tutorial
- tags: SEO, Blog, Content Marketing, AEO, GEO, Website

## Main Routes

- `/admin`: dashboard
- `/admin/posts`: blog list, search, filter, sort, duplicate, archive, delete
- `/admin/posts/new`: editor
- `/admin/posts/[id]`: edit existing post
- `/admin/categories`: category manager
- `/admin/tags`: tag manager
- `/admin/media`: media library
- `/admin/seo`: SEO/AEO/GEO defaults placeholder
- `/admin/authors`: role setup guidance
- `/admin/settings`: system settings placeholder
- `/admin/assistant`: AI assistant prompt templates
- `/blog`: public blog listing
- `/blog/[slug]`: public post detail with JSON-LD
- `/category/[slug]`: category listing
- `/tag/[slug]`: tag listing
- `/author/[id]`: author listing

## Build

```bash
npm run build
npm start
```

## Notes

- This is not a static mockup: posts, categories, tags, users, media, and revisions are stored in Firestore.
- Uploads use Firebase Storage under `blogs/`.
- Autosave runs in the editor after content changes.
- Public pages only show `published` posts.
- `savePost` validates title, URL-safe slug, and duplicate slug; the editor validates schedule date and role-limited publish actions before saving.
