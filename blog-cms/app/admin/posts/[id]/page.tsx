'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PostEditor } from '@/components/PostEditor';
import { Panel, Skeleton } from '@/components/ui';
import { getPost } from '@/lib/blogRepository';
import type { BlogPost } from '@/lib/types';

function EditorLoadSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]" role="status" aria-label="Loading">
      <div className="grid gap-4">
        <Panel className="grid gap-3">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-10 w-full" />
        </Panel>
        <Panel>
          <Skeleton className="mb-3 h-10 w-full" />
          <Skeleton className="h-96 w-full" />
        </Panel>
      </div>
      <aside className="grid content-start gap-4">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-48 w-full" />)}
      </aside>
    </div>
  );
}

export default function EditPostPage() {
  const params = useParams<{ id: string }>();
  const [post, setPost] = useState<BlogPost | null | undefined>(undefined);
  useEffect(() => { getPost(params.id).then(setPost); }, [params.id]);
  if (post === undefined) return <EditorLoadSkeleton />;
  if (!post) return <p className="font-bold">ไม่พบบทความ</p>;
  return <PostEditor initial={post} />;
}
