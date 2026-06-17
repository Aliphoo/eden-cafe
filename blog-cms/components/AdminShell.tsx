'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BarChart3, FileText, FolderTree, Image, LogOut, PenLine, Search, Settings, Sparkles, Tags, Users } from 'lucide-react';
import { AuthProvider, useAuth } from './AuthProvider';
import { Button } from './ui';
import { cn } from '@/lib/utils';

const nav = [
  { href: '/admin', label: 'ภาพรวม', icon: BarChart3 },
  { href: '/admin/posts', label: 'บทความทั้งหมด', icon: FileText },
  { href: '/admin/posts/new', label: 'เพิ่มบทความใหม่', icon: PenLine },
  { href: '/admin/categories', label: 'หมวดหมู่', icon: FolderTree },
  { href: '/admin/tags', label: 'Tags', icon: Tags },
  { href: '/admin/media', label: 'Media Library', icon: Image },
  { href: '/admin/seo', label: 'SEO Settings', icon: Search },
  { href: '/admin/authors', label: 'ผู้เขียน', icon: Users },
  { href: '/admin/settings', label: 'ตั้งค่าระบบ Blog', icon: Settings },
  { href: '/admin/assistant', label: 'AI Assistant', icon: Sparkles }
];

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, blogUser, loading, login, logout } = useAuth();

  if (loading) return <div className="grid min-h-screen place-items-center text-sm font-bold">กำลังโหลดระบบ...</div>;
  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <section className="w-full max-w-md rounded-lg border border-line bg-white p-6 shadow-panel">
          <p className="text-sm font-bold text-leaf">Eden Blog CMS</p>
          <h1 className="mt-2 text-2xl font-black">เข้าสู่ระบบหลังบ้าน Blog</h1>
          <p className="mt-3 text-sm leading-7 text-[#5e6d63]">ใช้บัญชี Google ที่ได้รับสิทธิ์ Admin, Editor หรือ Writer ใน Firestore collection `blog_users`.</p>
          <Button className="mt-5 w-full" onClick={login}>Login with Google</Button>
        </section>
      </main>
    );
  }

  return (
    <div className="grid min-h-screen grid-cols-[260px_1fr] max-lg:grid-cols-1">
      <aside className="border-r border-line bg-white p-4 max-lg:hidden">
        <Link href="/admin" className="block rounded-md bg-mist p-4">
          <span className="text-sm font-bold text-leaf">Eden Cafe</span>
          <strong className="block text-xl">Blog CMS</strong>
        </Link>
        <nav className="mt-5 grid gap-1">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || (item.href !== '/admin' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={cn('flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-bold text-[#405148]', active && 'bg-[#e8f3ec] text-leaf')}>
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 rounded-md border border-line p-3 text-sm">
          <strong>{blogUser?.name || user.email}</strong>
          <p className="mt-1 text-[#657369]">Role: {blogUser?.role || 'writer'}</p>
          <Button variant="ghost" className="mt-3 w-full justify-start" onClick={async () => { await logout(); router.push('/admin'); }}>
            <LogOut size={16} /> ออกจากระบบ
          </Button>
        </div>
      </aside>
      <main className="min-w-0 p-5 lg:p-7">{children}</main>
    </div>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ShellInner>{children}</ShellInner>
    </AuthProvider>
  );
}
