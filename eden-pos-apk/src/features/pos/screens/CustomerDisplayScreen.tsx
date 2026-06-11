import { MonitorCheck, QrCode } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatCurrency } from "../../../domain/money";
import {
  buildPromptPayPayload,
  createQrDataUrlWithLogo
} from "../../../integrations/promptPay";
import {
  getDefaultCustomerDisplayState,
  loadCustomerDisplaySettings,
  readCustomerDisplayState,
  subscribeCustomerDisplayState,
  type CustomerDisplaySettings,
  type CustomerDisplayState
} from "../../../integrations/customerDisplay";
import edenLogo from "../../../assets/eden-logo.webp";

export const CustomerDisplayScreen = () => {
  const [state, setState] = useState<CustomerDisplayState>(() => ({
    ...getDefaultCustomerDisplayState(),
    ...readCustomerDisplayState()
  }));
  const [settings, setSettings] = useState<CustomerDisplaySettings>(() =>
    loadCustomerDisplaySettings()
  );
  const [qrUrl, setQrUrl] = useState("");

  useEffect(() => subscribeCustomerDisplayState(setState), []);

  useEffect(() => {
    const syncSettings = () => setSettings(loadCustomerDisplaySettings());
    window.addEventListener("storage", syncSettings);
    window.addEventListener("focus", syncSettings);
    return () => {
      window.removeEventListener("storage", syncSettings);
      window.removeEventListener("focus", syncSettings);
    };
  }, []);

  useEffect(() => {
    if (
      state.paymentMethod !== "qr" ||
      !settings.showQr ||
      !state.promptPayId ||
      state.total <= 0
    ) {
      setQrUrl("");
      return;
    }

    if (state.promptPayQrDataUrl) {
      setQrUrl(state.promptPayQrDataUrl);
    }

    const payload = buildPromptPayPayload(state.total, {
      promptPayId: state.promptPayId,
      merchantName: state.merchantName,
      city: state.city
    });

    let active = true;
    void createQrDataUrlWithLogo(payload).then((url) => {
      if (active) {
        setQrUrl(url);
      }
    });

    return () => {
      active = false;
    };
  }, [
    settings.showQr,
    state.city,
    state.merchantName,
    state.paymentMethod,
    state.promptPayId,
    state.promptPayQrDataUrl,
    state.total
  ]);

  const visibleLines = useMemo(
    () => (settings.showLineItems ? state.lines : []),
    [settings.showLineItems, state.lines]
  );
  const hasOrder = state.lines.length > 0;

  return (
    <main className={`customer-display-screen ${hasOrder ? "active" : "idle"}`}>
      <section className="customer-display-hero">
        <div className="customer-display-brand">
          <img alt="Eden Cafe" src={edenLogo} />
          <div>
            <span>{state.storeName}</span>
            <strong>
              {hasOrder ? "รายการของคุณ" : settings.idleMessage}
            </strong>
          </div>
        </div>

        <div className="customer-display-total">
          <span>{hasOrder ? "ยอดชำระ" : "พร้อมรับออเดอร์"}</span>
          <strong>{formatCurrency(state.total)}</strong>
          <small>{hasOrder ? state.message : settings.promoMessage}</small>
        </div>
      </section>

      {hasOrder ? (
        <section className="customer-display-grid">
          <div className="customer-display-lines">
            <div className="customer-display-section-title">
              <MonitorCheck aria-hidden="true" size={20} />
              <span>สินค้า {state.lines.length} รายการ</span>
            </div>
            {visibleLines.map((line) => (
              <article className="customer-display-line" key={line.id}>
                <div>
                  <strong>{line.name}</strong>
                  {line.variantName && <small>{line.variantName}</small>}
                  {line.note && <small>{line.note}</small>}
                </div>
                <span>x{line.quantity}</span>
                <strong>{formatCurrency(line.total)}</strong>
              </article>
            ))}
          </div>

          <aside className="customer-display-payment">
            {qrUrl ? (
              <>
                <div className="customer-display-section-title">
                  <QrCode aria-hidden="true" size={20} />
                  <span>PromptPay</span>
                </div>
                <img alt="PromptPay QR" src={qrUrl} />
                <small>สแกนเพื่อชำระ {formatCurrency(state.total)}</small>
              </>
            ) : (
              <div className="customer-display-waiting">
                <QrCode aria-hidden="true" size={54} />
                <strong>{state.paymentLabel || "รอเลือกวิธีชำระเงิน"}</strong>
              </div>
            )}
            <dl>
              <div>
                <dt>ยอดสินค้า</dt>
                <dd>{formatCurrency(state.subtotal)}</dd>
              </div>
              <div>
                <dt>ส่วนลด</dt>
                <dd>{formatCurrency(state.discount)}</dd>
              </div>
              <div>
                <dt>VAT รวมในราคา</dt>
                <dd>{formatCurrency(state.taxIncluded)}</dd>
              </div>
              <div className="customer-display-grand-total">
                <dt>รวมสุทธิ</dt>
                <dd>{formatCurrency(state.total)}</dd>
              </div>
            </dl>
          </aside>
        </section>
      ) : (
        <section className="customer-display-idle-card">
          <MonitorCheck aria-hidden="true" size={84} />
          <strong>{settings.promoMessage}</strong>
          <span>รายการสินค้า ยอดรวม และ QR ชำระเงินจะแสดงทันทีเมื่อเริ่มขาย</span>
        </section>
      )}
    </main>
  );
};
