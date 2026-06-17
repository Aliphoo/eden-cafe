import { Panel } from '@/components/ui';

export default function SeoPage() {
  return (
    <Panel className="max-w-3xl">
      <p className="text-sm font-bold text-leaf">SEO Settings</p>
      <h1 className="mt-1 text-3xl font-black">ค่าเริ่มต้น SEO / AEO / GEO</h1>
      <p className="mt-4 leading-7 text-[#536159]">ระบบรองรับ meta title, meta description, canonical, OG/Twitter, FAQ Schema, Article Schema, Breadcrumb Schema และ LocalBusiness context ในระดับบทความแล้ว หน้านี้เตรียมไว้สำหรับค่า default ของ brand/site เช่น ชื่อร้าน ที่อยู่ เบอร์โทร และ social image กลาง.</p>
    </Panel>
  );
}
