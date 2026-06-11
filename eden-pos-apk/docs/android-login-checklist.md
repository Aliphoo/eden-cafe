# Eden POS APK Login Checklist

เอกสารนี้สรุปสถานะล่าสุดของระบบล็อกอินและสิ่งที่ต้องตั้งค่าใน Firebase สำหรับ Eden POS APK

## สถานะเครื่อง build ตอนนี้

- JDK: `C:\Users\ROG\.eden-pos-tools\jdk\jdk-21.0.11+10`
- Android SDK: `C:\Users\ROG\AppData\Local\Android\Sdk`
- Package name / application id: `com.personal.pos`
- Google Sign-In dependency ถูกเปิดใน `android/variables.gradle` ด้วย `rgcfaIncludeGoogle = true`
- ยังไม่พบไฟล์ `android/app/google-services.json`
- ตอนตรวจล่าสุด `adb devices -l` ยังไม่พบแท็บเล็ตที่ต่อ USB debugging

## Firebase Sign-In Providers

เปิดใน Firebase Console:

1. ไปที่ `Authentication > Sign-in method`
2. เปิด `Email/Password`
3. เปิด `Google`
4. ถ้าขึ้น `auth/operation-not-allowed` แปลว่าวิธีล็อกอินนั้นยังไม่ได้เปิด

## Android App ใน Firebase

สำหรับ Google Login บน APK ต้องมี Android app ใน Firebase ที่ตรงกับ package นี้:

- Package name: `com.personal.pos`
- SHA-1 debug: `E4:DA:51:93:A1:67:B0:E8:4D:AC:09:7A:65:59:2B:68:39:2E:13:26`
- SHA-256 debug: `B3:57:30:49:55:41:E8:61:0B:6B:D0:28:93:68:82:24:DF:49:71:24:64:C8:CC:43:06:73:5E:34:DE:B8:E8:71`

หลังเพิ่ม Android app และ SHA แล้ว ให้ดาวน์โหลด `google-services.json` จาก Firebase แล้ววางที่:

```text
android/app/google-services.json
```

จากนั้น rebuild APK ใหม่

## Build Commands

ใช้ PowerShell จากโฟลเดอร์ `D:\Eden Cafe Website\eden-pos-apk`

```powershell
$jdkHome = [Environment]::GetEnvironmentVariable('JAVA_HOME','User')
$sdkRoot = [Environment]::GetEnvironmentVariable('ANDROID_HOME','User')
$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:Path = "$jdkHome\bin;$sdkRoot\cmdline-tools\latest\bin;$sdkRoot\platform-tools;$env:Path"

npm.cmd run android:sync
Push-Location android
.\gradlew.bat assembleDebug
Pop-Location
Copy-Item -LiteralPath 'D:\Eden Cafe Website\eden-pos-apk\android\app\build\outputs\apk\debug\app-debug.apk' -Destination 'D:\Eden Cafe Website\eden-pos-apk\EdenCafePOS-debug.apk' -Force
```

## Debug บนแท็บเล็ต

1. เปิด Developer options บนแท็บเล็ต
2. เปิด USB debugging
3. ต่อสาย USB และกดยอมรับ RSA prompt
4. ตรวจเครื่อง:

```powershell
$sdkRoot = [Environment]::GetEnvironmentVariable('ANDROID_HOME','User')
& "$sdkRoot\platform-tools\adb.exe" devices -l
```

ถ้าต้องอ่าน log ตอนกด Google Login:

```powershell
& "$sdkRoot\platform-tools\adb.exe" logcat -c
# กดล็อกอินในแท็บเล็ต
& "$sdkRoot\platform-tools\adb.exe" logcat -d | Select-String -Pattern 'FirebaseAuthentication|Google|DEVELOPER_ERROR|ApiException|Capacitor|Auth'
```
