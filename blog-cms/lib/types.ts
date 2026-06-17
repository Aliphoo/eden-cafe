export type BlogRole = 'admin' | 'editor' | 'writer';
export type PostStatus = 'draft' | 'published' | 'scheduled' | 'archived';
export type ChecklistState = 'ผ่าน' | 'ควรปรับปรุง' | 'ยังไม่ได้ทำ';

export type BlogUser = {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
  bio?: string;
  role: BlogRole;
  created_at?: string;
  updated_at?: string;
};

export type Category = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  cover_image_url?: string;
  seo_title?: string;
  seo_description?: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

export type Tag = {
  id: string;
  name: string;
  slug: string;
  created_at?: string;
  updated_at?: string;
};

export type MediaAsset = {
  id: string;
  filename: string;
  url: string;
  alt_text?: string;
  caption?: string;
  size: number;
  mime_type: string;
  uploaded_by: string;
  created_at?: string;
};

export type FaqItem = {
  question: string;
  answer: string;
};

export type BlogPost = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  cover_image_url?: string;
  cover_image_alt?: string;
  cover_image_caption?: string;
  status: PostStatus;
  author_id: string;
  author_name?: string;
  category_id?: string;
  category_name?: string;
  tag_ids: string[];
  tags?: string[];
  seo_title?: string;
  seo_description?: string;
  focus_keyword?: string;
  canonical_url?: string;
  og_title?: string;
  og_description?: string;
  og_image_url?: string;
  twitter_title?: string;
  twitter_description?: string;
  twitter_image_url?: string;
  robots_index: boolean;
  robots_follow: boolean;
  schema_type: 'Article' | 'BlogPosting' | 'FAQPage' | 'LocalBusiness' | 'Organization' | 'Product';
  brand_context?: string;
  business_context?: string;
  faqs: FaqItem[];
  reading_time: number;
  word_count: number;
  is_featured: boolean;
  published_at?: string;
  scheduled_at?: string;
  created_at?: string;
  updated_at?: string;
};
