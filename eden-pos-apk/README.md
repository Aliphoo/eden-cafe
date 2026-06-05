# POS ส่วนตัวสำหรับทำ APK

โปรเจกต์นี้เป็นโครงตั้งต้นสำหรับ POS ใช้เองแบบออฟไลน์ สร้างด้วย React + Vite และเตรียมห่อเป็น Android APK ด้วย Capacitor

## โครงสร้าง

```text
src/
  domain/        ชนิดข้อมูลและ logic คำนวณเงิน
  storage/       seed data และ persistence ในเครื่อง
  features/pos/  หน้าขายสินค้า ตะกร้า รับเงิน สินค้า ใบเสร็จ
  styles/        สไตล์ของแอพ
capacitor.config.ts
```

## คำสั่งหลัก

ถ้า PowerShell บล็อก `npm` ให้ใช้ `npm.cmd` แทน

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build
```

## ทำ Android APK

ติดตั้ง Android Studio และ JDK 17 หรือใหม่กว่าก่อน จากนั้นรัน

```powershell
npm.cmd run android:add
npm.cmd run android:open
```

ในโปรเจกต์นี้สร้างโฟลเดอร์ `android/` ไว้แล้ว ครั้งถัดไปใช้ `npm.cmd run android:sync` แล้วค่อยเปิด Android Studio ด้วย `npm.cmd run android:open`

ใน Android Studio ให้เลือก `Build > Generate Signed Bundle / APK` แล้วเลือก `APK`

หลังแก้โค้ดเว็บ ให้ sync เข้า Android ด้วย

```powershell
npm.cmd run android:sync
```

## Eden Cafe Web Sync

- แอพอ่านเมนูและหมวดหมู่จาก Firebase โปรเจกต์เดียวกับ `www.edencafe.co`
- ระบบชำระเงินทำงานใน Eden POS APK และซิงค์ข้อมูลกับ Firebase โปรเจกต์เดียวกับ `www.edencafe.co`
- PromptPay ใช้ payload/CRC แบบเดิม พร้อม QR ตามยอดสุทธิ
- ภาษี 7% เป็น VAT รวมในราคา ไม่ได้บวกเพิ่มตอนคิดยอด
- ถ้ายังไม่ได้ล็อกอินแอดมิน Eden ใบเสร็จจะเก็บในเครื่องก่อนและแสดงสถานะ local
- เมื่อล็อกอินแอดมินผ่านหน้าตั้งค่า ใบเสร็จใหม่จะพยายามส่งเข้า collection `orders` ของ Firestore

## แนวต่อยอด

- เชื่อมเครื่องพิมพ์ใบเสร็จผ่าน Bluetooth หรือ USB
- เพิ่ม barcode scanner ด้วยกล้องหรือเครื่องสแกนที่พิมพ์เป็นคีย์บอร์ด
- ย้าย storage จาก localStorage เป็น SQLite เมื่อข้อมูลเริ่มเยอะ
- เพิ่มรายงานยอดขาย รายวัน รายเดือน และ export CSV
