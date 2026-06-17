import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage } from './firebase';
import type { BlogPost, BlogUser, Category, MediaAsset, Tag } from './types';
import { countWords, nowIso, readingTime, slugify, toDoc } from './utils';

export const collections = {
  posts: 'blogs',
  categories: 'blog_categories',
  tags: 'blog_tags',
  media: 'blog_media_assets',
  revisions: 'blog_revisions',
  users: 'blog_users',
  settings: 'blog_settings'
};

export async function getCurrentBlogUser(uid: string, email?: string | null, name?: string | null) {
  const snap = await getDoc(doc(db, collections.users, uid));
  if (snap.exists()) return toDoc<BlogUser>(snap.id, snap.data());
  return {
    id: uid,
    name: name || email || 'Writer',
    email: email || '',
    role: 'writer' as const,
    created_at: nowIso()
  };
}

export async function listPosts(includeDrafts = true) {
  const q = includeDrafts
    ? query(collection(db, collections.posts), orderBy('updated_at', 'desc'), limit(100))
    : query(collection(db, collections.posts), where('status', '==', 'published'), orderBy('published_at', 'desc'), limit(100));
  const snap = await getDocs(q);
  return snap.docs.map((item) => toDoc<BlogPost>(item.id, item.data()));
}

export async function getPost(id: string) {
  const snap = await getDoc(doc(db, collections.posts, id));
  return snap.exists() ? toDoc<BlogPost>(snap.id, snap.data()) : null;
}

export async function getPostBySlug(slug: string) {
  const snap = await getDocs(query(collection(db, collections.posts), where('slug', '==', slug), limit(1)));
  return snap.empty ? null : toDoc<BlogPost>(snap.docs[0].id, snap.docs[0].data());
}

async function assertUniqueSlug(slug: string, currentId?: string) {
  const snap = await getDocs(query(collection(db, collections.posts), where('slug', '==', slug), limit(2)));
  const duplicate = snap.docs.find((item) => item.id !== currentId);
  if (duplicate) throw new Error('Slug นี้ถูกใช้งานแล้ว กรุณาเปลี่ยน URL Slug');
}

export async function savePost(post: Partial<BlogPost>, actor: BlogUser) {
  if (!post.title?.trim()) throw new Error('กรุณาใส่ชื่อบทความ');
  const slug = slugify(post.slug || post.title);
  if (!slug) throw new Error('Slug ไม่ถูกต้อง');
  await assertUniqueSlug(slug, post.id);
  const words = countWords(post.content || '');
  const payload: Partial<BlogPost> = {
    ...post,
    slug,
    title: post.title.trim(),
    excerpt: post.excerpt || '',
    content: post.content || '',
    status: post.status || 'draft',
    author_id: post.author_id || actor.id,
    author_name: post.author_name || actor.name,
    tag_ids: post.tag_ids || [],
    tags: post.tags || [],
    faqs: post.faqs || [],
    robots_index: post.robots_index ?? true,
    robots_follow: post.robots_follow ?? true,
    schema_type: post.schema_type || 'BlogPosting',
    reading_time: readingTime(words),
    word_count: words,
    is_featured: post.is_featured ?? false,
    updated_at: nowIso()
  };
  if (payload.status === 'published' && !payload.published_at) payload.published_at = nowIso();
  if (!post.id) {
    payload.created_at = nowIso();
    const created = await addDoc(collection(db, collections.posts), payload);
    return created.id;
  }
  await updateDoc(doc(db, collections.posts, post.id), payload);
  await addDoc(collection(db, collections.revisions), {
    post_id: post.id,
    title: payload.title,
    content: payload.content,
    edited_by: actor.id,
    created_at: nowIso()
  });
  return post.id;
}

export async function duplicatePost(post: BlogPost, actor: BlogUser) {
  return savePost({
    ...post,
    id: undefined,
    title: `${post.title} Copy`,
    slug: `${post.slug}-copy-${Date.now()}`,
    status: 'draft',
    published_at: undefined,
    scheduled_at: undefined
  }, actor);
}

export async function archivePost(id: string) {
  await updateDoc(doc(db, collections.posts, id), { status: 'archived', updated_at: nowIso() });
}

export async function deletePost(id: string) {
  await deleteDoc(doc(db, collections.posts, id));
}

export async function listCategories() {
  const snap = await getDocs(query(collection(db, collections.categories), orderBy('name')));
  return snap.docs.map((item) => toDoc<Category>(item.id, item.data()));
}

export async function saveCategory(category: Partial<Category>) {
  const id = category.id || slugify(category.slug || category.name || '');
  if (!id) throw new Error('กรุณาใส่ชื่อหมวดหมู่');
  await setDoc(doc(db, collections.categories, id), {
    name: category.name,
    slug: slugify(category.slug || category.name || ''),
    description: category.description || '',
    cover_image_url: category.cover_image_url || '',
    seo_title: category.seo_title || '',
    seo_description: category.seo_description || '',
    is_active: category.is_active ?? true,
    updated_at: nowIso(),
    created_at: category.created_at || nowIso()
  }, { merge: true });
  return id;
}

export async function listTags() {
  const snap = await getDocs(query(collection(db, collections.tags), orderBy('name')));
  return snap.docs.map((item) => toDoc<Tag>(item.id, item.data()));
}

export async function listUsers() {
  const snap = await getDocs(query(collection(db, collections.users), orderBy('name')));
  return snap.docs.map((item) => toDoc<BlogUser>(item.id, item.data()));
}

export async function saveTag(tag: Partial<Tag>) {
  const id = tag.id || slugify(tag.slug || tag.name || '');
  if (!id) throw new Error('กรุณาใส่ชื่อ Tag');
  await setDoc(doc(db, collections.tags, id), {
    name: tag.name,
    slug: slugify(tag.slug || tag.name || ''),
    updated_at: nowIso(),
    created_at: tag.created_at || nowIso()
  }, { merge: true });
  return id;
}

export async function listMedia() {
  const snap = await getDocs(query(collection(db, collections.media), orderBy('created_at', 'desc'), limit(100)));
  return snap.docs.map((item) => toDoc<MediaAsset>(item.id, item.data()));
}

export async function uploadMedia(file: File, actor: BlogUser, meta: { alt_text?: string; caption?: string } = {}) {
  const path = `blogs/${Date.now()}-${slugify(file.name) || file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file, { contentType: file.type });
  const url = await getDownloadURL(storageRef);
  const payload = {
    filename: file.name,
    url,
    alt_text: meta.alt_text || '',
    caption: meta.caption || '',
    size: file.size,
    mime_type: file.type,
    uploaded_by: actor.id,
    storage_path: path,
    created_at: nowIso()
  };
  const created = await addDoc(collection(db, collections.media), payload);
  return { id: created.id, ...payload };
}

export async function deleteMedia(asset: MediaAsset & { storage_path?: string }) {
  await deleteDoc(doc(db, collections.media, asset.id));
  if (asset.storage_path) await deleteObject(ref(storage, asset.storage_path));
}
