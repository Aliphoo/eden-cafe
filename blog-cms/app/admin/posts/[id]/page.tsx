'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PostEditor } from '@/components/PostEditor';
import { getPost } from '@/lib/blogRepository';
import type { BlogPost } from '@/lib/types';

export default function EditPostPage() {
  const params = useParams<{ id: string }>();
  const [post, setPost] = useState<BlogPost | null | undefined>(undefined);
  useEffect(() => { getPost(params.id).then(setPost); }, [params.id]);
  if (post === undefined) return <p className="font-bold">กำลังโหลดบทความ...</p>;
  if (!post) return <p className="font-bold">ไม่พบบทความ</p>;
  return <PostEditor initial={post} />;
}
