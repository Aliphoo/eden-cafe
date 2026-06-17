import { Panel } from '@/components/ui';

export default function SettingsPage() {
  return (
    <Panel className="max-w-3xl">
      <p className="text-sm font-bold text-leaf">ตั้งค่าระบบ Blog</p>
      <h1 className="mt-1 text-3xl font-black">Blog System Settings</h1>
      <p className="mt-4 leading-7 text-[#536159]">โครงสร้างพร้อมสำหรับต่อค่า default URL, social sharing, sitemap, scheduled publish worker และการเชื่อม e-commerce หรือ landing page ในอนาคต.</p>
    </Panel>
  );
}
