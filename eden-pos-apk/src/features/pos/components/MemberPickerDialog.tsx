import { Plus, RefreshCw, Search, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatNumber } from "../../../domain/money";
import type { CustomerProfile } from "../../../domain/pos";
import { loadEdenMembers } from "../../../integrations/edenFirebase";

type MemberPickerDialogProps = {
  localCustomers: CustomerProfile[];
  open: boolean;
  onClose(): void;
  onCreateNew(): void;
  onSelect(customer: CustomerProfile): void;
};

const memberSearchText = (customer: CustomerProfile) =>
  [
    customer.displayName,
    customer.email,
    customer.phone,
    customer.phoneNormalized,
    customer.lineId,
    customer.memberCode,
    customer.tier
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const mergeMembers = (
  remoteMembers: CustomerProfile[],
  localCustomers: CustomerProfile[]
) => {
  const byKey = new Map<string, CustomerProfile>();

  [...remoteMembers, ...localCustomers].forEach((customer) => {
    const key = customer.uid || customer.phoneNormalized || customer.phone;
    if (key && !byKey.has(key)) {
      byKey.set(key, customer);
    }
  });

  return Array.from(byKey.values());
};

export const MemberPickerDialog = ({
  localCustomers,
  onClose,
  onCreateNew,
  onSelect,
  open
}: MemberPickerDialogProps) => {
  const [members, setMembers] = useState<CustomerProfile[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const refreshMembers = async () => {
    setLoading(true);
    setMessage("กำลังโหลดสมาชิกจากหลังบ้าน...");
    try {
      const remoteMembers = await loadEdenMembers({ limitCount: 300 });
      setMembers(remoteMembers);
      setMessage(
        remoteMembers.length
          ? `โหลดสมาชิกจากหลังบ้าน ${remoteMembers.length.toLocaleString("th-TH")} รายการ`
          : "ยังไม่มีสมาชิกจากหลังบ้าน"
      );
    } catch (error) {
      setMembers([]);
      setMessage(
        error instanceof Error
          ? `โหลดสมาชิกไม่ได้: ${error.message}`
          : "โหลดสมาชิกไม่ได้"
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setSearch("");
      void refreshMembers();
    }
  }, [open]);

  const visibleMembers = useMemo(() => {
    const allMembers = mergeMembers(members, localCustomers);
    const query = search.trim().toLowerCase();
    const digits = search.replace(/\D/g, "");

    return allMembers
      .filter((customer) => {
        if (!query) return true;
        return (
          memberSearchText(customer).includes(query) ||
          (digits ? customer.phoneNormalized.includes(digits) : false)
        );
      })
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "eden" ? -1 : 1;
        const codeA = a.memberCode || "";
        const codeB = b.memberCode || "";
        if (codeA && codeB && codeA !== codeB) {
          return codeA.localeCompare(codeB, "th");
        }
        return a.displayName.localeCompare(b.displayName, "th");
      });
  }, [localCustomers, members, search]);

  if (!open) {
    return null;
  }

  return (
    <div
      aria-labelledby="member-picker-title"
      aria-modal="true"
      className="member-picker-backdrop"
      role="dialog"
    >
      <section className="member-picker-panel">
        <header className="member-picker-header">
          <button
            aria-label="ปิด"
            className="member-picker-icon"
            onClick={onClose}
            title="ปิด"
            type="button"
          >
            <X size={26} />
          </button>
          <h2 id="member-picker-title">เพิ่มลูกค้าลงในตั๋ว</h2>
          <button
            aria-label="โหลดสมาชิกใหม่"
            className="member-picker-icon"
            disabled={loading}
            onClick={() => void refreshMembers()}
            title="โหลดสมาชิกใหม่"
            type="button"
          >
            <RefreshCw size={22} />
          </button>
        </header>

        <label className="member-picker-search">
          <Search aria-hidden="true" size={24} />
          <input
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ค้นหาชื่อ เบอร์โทร อีเมล หรือรหัสสมาชิก"
            value={search}
          />
        </label>

        <button
          className="member-picker-create"
          onClick={onCreateNew}
          type="button"
        >
          <Plus aria-hidden="true" size={20} />
          เพิ่มลูกค้าใหม่
        </button>

        <div className="member-picker-status">{message}</div>

        <div className="member-picker-list" role="list">
          {visibleMembers.length ? (
            visibleMembers.map((customer) => (
              <button
                className="member-picker-row"
                key={`${customer.source}-${customer.uid}`}
                onClick={() => onSelect(customer)}
                role="listitem"
                type="button"
              >
                <span className="member-avatar">
                  <UserRound size={30} />
                </span>
                <span className="member-main">
                  <strong>
                    {customer.memberCode ? `${customer.memberCode} ` : ""}
                    {customer.displayName}
                  </strong>
                  <small>
                    {[customer.email, customer.phone].filter(Boolean).join(", ") ||
                      customer.tier ||
                      customer.uid}
                  </small>
                </span>
                <span className={`member-source ${customer.source}`}>
                  {customer.source === "eden" ? "หลังบ้าน" : "ในเครื่อง"}
                  <small>{formatNumber(customer.points ?? 0)} แต้ม</small>
                </span>
              </button>
            ))
          ) : (
            <div className="member-picker-empty">
              {loading ? "กำลังโหลด..." : "ไม่พบสมาชิกที่ตรงกับคำค้นหา"}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
