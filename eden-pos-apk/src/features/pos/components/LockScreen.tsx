import { Delete, LockKeyhole, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type LockScreenProps = {
  locked: boolean;
  storeName: string;
  timeoutMinutes: number;
  onUnlock(pin: string): Promise<boolean>;
};

const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const edenLogoPng = "/Images/eden-logo.png";
const edenLogoWebp = "/Images/eden-logo.webp";

export const LockScreen = ({
  locked,
  onUnlock,
  storeName,
  timeoutMinutes
}: LockScreenProps) => {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("ใส่ PIN เพื่อกลับเข้าใช้งาน");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (locked) {
      setPin("");
      setBusy(false);
      setMessage("ใส่ PIN เพื่อกลับเข้าใช้งาน");
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [locked]);

  if (!locked) {
    return null;
  }

  const appendDigit = (digit: string) => {
    setPin((current) => `${current}${digit}`.slice(0, 12));
    setMessage("ใส่ PIN เพื่อกลับเข้าใช้งาน");
  };

  const submit = async () => {
    if (pin.length < 4) {
      setMessage("กรอก PIN อย่างน้อย 4 หลัก");
      return;
    }

    setBusy(true);
    const ok = await onUnlock(pin);
    if (!ok) {
      setPin("");
      setMessage("PIN ไม่ถูกต้อง ลองอีกครั้ง");
      inputRef.current?.focus();
    }
    setBusy(false);
  };

  return (
    <section className="lock-screen" aria-label="ล็อกหน้าจอ POS">
      <div className="lock-panel">
        <picture className="lock-brand">
          <source srcSet={edenLogoWebp} type="image/webp" />
          <img
            alt="Eden Coffee POS"
            className="lock-logo-image"
            src={edenLogoPng}
          />
        </picture>

        <div className="lock-copy">
          <span className="lock-chip">
            <ShieldCheck aria-hidden="true" size={16} />
            ล็อกอัตโนมัติ {timeoutMinutes} นาที
          </span>
          <h1>{storeName}</h1>
          <p>หน้าจอถูกล็อกเพื่อป้องกันการใช้งานโดยไม่ได้รับอนุญาต</p>
        </div>

        <label className="lock-pin-field">
          PIN
          <input
            autoComplete="off"
            inputMode="numeric"
            maxLength={12}
            onChange={(event) =>
              setPin(event.target.value.replace(/\D/g, "").slice(0, 12))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submit();
              }
            }}
            ref={inputRef}
            type="password"
            value={pin}
          />
        </label>

        <div className="lock-dots" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <span className={pin.length > index ? "filled" : ""} key={index} />
          ))}
        </div>

        <div className="lock-keypad">
          {keypad.map((digit) => (
            <button
              disabled={busy}
              key={digit}
              onClick={() => appendDigit(digit)}
              type="button"
            >
              {digit}
            </button>
          ))}
          <button
            aria-label="ลบเลขล่าสุด"
            disabled={busy || pin.length === 0}
            onClick={() => setPin((current) => current.slice(0, -1))}
            type="button"
          >
            <Delete aria-hidden="true" size={20} />
          </button>
        </div>

        <div className="lock-actions">
          <span>{message}</span>
          <button disabled={busy} onClick={() => void submit()} type="button">
            <LockKeyhole aria-hidden="true" size={18} />
            ปลดล็อก
          </button>
        </div>
      </div>
    </section>
  );
};
