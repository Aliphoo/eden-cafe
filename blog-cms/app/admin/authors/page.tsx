import { Panel } from '@/components/ui';

export default function AuthorsPage() {
  return (
    <Panel className="max-w-3xl">
      <p className="text-sm font-bold text-leaf">ผู้เขียน</p>
      <h1 className="mt-1 text-3xl font-black">Author & Role Permission</h1>
      <p className="mt-4 leading-7 text-[#536159]">เพิ่มผู้ใช้งานใน Firestore collection `blog_users` โดยใช้ document id เป็น Firebase Auth UID และกำหนด role เป็น `admin`, `editor` หรือ `writer`. Admin จัดการได้ทุกอย่าง, Editor publish ได้, Writer บันทึก Draft ได้.</p>
    </Panel>
  );
}
