import { Panel } from '@/components/ui';

const prompts = ['เขียนบทความ SEO', 'เขียนบทความข่าวสาร', 'เขียนบทความ How-to', 'เขียนบทความรีวิว', 'เขียน FAQ', 'เขียนบทนำ', 'เขียนสรุปท้ายบทความ'];

export default function AssistantPage() {
  return (
    <Panel>
      <p className="text-sm font-bold text-leaf">AI Blog Assistant</p>
      <h1 className="mt-1 text-3xl font-black">Prompt Templates</h1>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {prompts.map((prompt) => <div key={prompt} className="rounded-md border border-line p-4"><strong>{prompt}</strong><p className="mt-2 text-sm text-[#66746c]">ใช้เป็น template สำหรับเชื่อม OpenAI API หรือ workflow ภายในในขั้นถัดไป</p></div>)}
      </div>
    </Panel>
  );
}
