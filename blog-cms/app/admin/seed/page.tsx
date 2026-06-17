'use client';

import { useState } from 'react';
import { seedBlogCms } from '@/lib/seed';
import { useAuth } from '@/components/AuthProvider';
import { Button, Panel } from '@/components/ui';

export default function SeedPage() {
  const { blogUser, user } = useAuth();
  const [status, setStatus] = useState('');
  return (
    <Panel className="max-w-xl">
      <h1 className="text-2xl font-black">Seed Data ตัวอย่าง</h1>
      <p className="mt-3 leading-7 text-[#536159]">สร้างบทความ 5 บทความ หมวดหมู่ SEO/Marketing/Knowledge/News/Tutorial และ Tags ตัวอย่างลง Firestore จริง.</p>
      <Button className="mt-4" onClick={async () => {
        if (!user || !blogUser) return;
        setStatus('กำลัง seed...');
        await seedBlogCms(user.uid, blogUser.name || user.email || 'Eden Writer');
        setStatus('Seed สำเร็จ');
      }}>Run Seed</Button>
      {status && <p className="mt-4 font-bold">{status}</p>}
    </Panel>
  );
}
