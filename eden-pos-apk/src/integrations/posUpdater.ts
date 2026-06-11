import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  POS_BUILD_VERSION_CODE,
  POS_BUILD_VERSION_NAME
} from "../buildInfo";
import { getCurrentEdenAdminIdToken } from "./edenFirebase";

export const POS_UPDATER_APP_ID = "com.personal.pos";
export const POS_UPDATER_DEFAULT_CHANNEL: PosUpdateChannel = "test";
export const POS_UPDATER_BUILD_VERSION_NAME = POS_BUILD_VERSION_NAME;
export const POS_UPDATER_BUILD_VERSION_CODE = POS_BUILD_VERSION_CODE;

const FUNCTIONS_BASE_URL =
  "https://asia-southeast1-edencafe-d9095.cloudfunctions.net";
const CHECK_UPDATE_ENDPOINT = `${FUNCTIONS_BASE_URL}/checkPosApkUpdate`;
const DOWNLOAD_RELEASE_ENDPOINT = `${FUNCTIONS_BASE_URL}/downloadPosApkRelease`;
const REPORT_EVENT_ENDPOINT = `${FUNCTIONS_BASE_URL}/reportPosUpdateEvent`;
const DEVICE_ID_STORAGE_KEY = "edenPosDeviceIdV1";
const PENDING_INSTALL_STORAGE_KEY = "edenPosPendingApkInstallV1";

export type PosUpdateChannel = "test" | "pilot" | "production";
export type PosUpdateEventName =
  | "downloaded"
  | "install_started"
  | "installed"
  | "failed";

export type InstalledPosVersion = {
  versionName: string;
  versionCode: number;
  packageName: string;
  native: boolean;
};

export type PosUpdateRelease = {
  releaseId: string;
  appId: string;
  versionName: string;
  versionCode: number;
  channel: PosUpdateChannel;
  sha256: string;
  size: number;
  releaseNotes: string;
  minSupportedVersionCode: number;
  forceUpdate: boolean;
};

export type PosUpdateCheckResult =
  | {
      updateAvailable: false;
      appId: string;
      channel: PosUpdateChannel;
      currentVersionCode: number;
    }
  | ({
      updateAvailable: true;
      currentVersionCode: number;
    } & PosUpdateRelease);

export type DownloadedPosApk = {
  filePath?: string;
  objectUrl?: string;
  sha256: string;
  size: number;
  native: boolean;
};

export type PosUpdatePowerStatus = {
  batteryLevel: number;
  isCharging: boolean;
};

type NativeDownloadOptions = {
  endpoint: string;
  idToken: string;
  appId: string;
  channel: PosUpdateChannel;
  deviceId: string;
  releaseId: string;
  versionCode: number;
  sha256: string;
};

type NativeVerifyOptions = {
  filePath: string;
  sha256: string;
};

type NativeInstallOptions = {
  filePath: string;
};

type EdenPosUpdaterNative = {
  getInstalledVersion(): Promise<InstalledPosVersion>;
  downloadApkToPrivateStorage(
    options: NativeDownloadOptions
  ): Promise<DownloadedPosApk>;
  verifySha256(
    options: NativeVerifyOptions
  ): Promise<{ ok: boolean; actualSha256: string }>;
  launchPackageInstaller(options: NativeInstallOptions): Promise<{ ok: boolean }>;
  canRequestPackageInstalls(): Promise<{ allowed: boolean }>;
  openInstallUnknownAppsSettings(): Promise<{ ok: boolean }>;
  getPowerStatus(): Promise<PosUpdatePowerStatus>;
};

const EdenPosUpdater = registerPlugin<EdenPosUpdaterNative>("EdenPosUpdater");

const isNativeUpdaterAvailable = () => Capacitor.isNativePlatform();

const normalizeChannel = (value: string): PosUpdateChannel =>
  value === "pilot" || value === "production" ? value : "test";

const normalizeSha256 = (value: unknown) =>
  String(value ?? "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase();

const normalizeRelease = (payload: Record<string, unknown>): PosUpdateRelease => ({
  releaseId: String(payload.releaseId || ""),
  appId: String(payload.appId || POS_UPDATER_APP_ID),
  versionName: String(payload.versionName || ""),
  versionCode: Number(payload.versionCode) || 0,
  channel: normalizeChannel(String(payload.channel || POS_UPDATER_DEFAULT_CHANNEL)),
  sha256: normalizeSha256(payload.sha256),
  size: Number(payload.size) || 0,
  releaseNotes: String(payload.releaseNotes || ""),
  minSupportedVersionCode: Number(payload.minSupportedVersionCode) || 0,
  forceUpdate: payload.forceUpdate === true
});

const readJsonResponse = async <T>(response: Response): Promise<T> => {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as Record<string, unknown>)
    : { error: await response.text() };

  if (!response.ok) {
    throw new Error(String(payload.error || `HTTP ${response.status}`));
  }

  return payload as T;
};

const postJson = async <T>(
  endpoint: string,
  idToken: string,
  body: Record<string, unknown>
) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return readJsonResponse<T>(response);
};

const blobSha256 = async (blob: Blob) => {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
};

export const getPosDeviceId = () => {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;

  const randomId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `pos-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deviceId = `${POS_UPDATER_APP_ID}:${randomId}`;
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  return deviceId;
};

export const getInstalledPosVersion = async (): Promise<InstalledPosVersion> => {
  if (isNativeUpdaterAvailable()) {
    return EdenPosUpdater.getInstalledVersion();
  }

  return {
    versionName: POS_UPDATER_BUILD_VERSION_NAME,
    versionCode: POS_UPDATER_BUILD_VERSION_CODE,
    packageName: POS_UPDATER_APP_ID,
    native: false
  };
};

export const checkPosApkUpdate = async ({
  channel = POS_UPDATER_DEFAULT_CHANNEL,
  currentVersionCode
}: {
  channel?: PosUpdateChannel;
  currentVersionCode: number;
}): Promise<PosUpdateCheckResult> => {
  const idToken = await getCurrentEdenAdminIdToken(true);
  const deviceId = getPosDeviceId();
  const payload = await postJson<Record<string, unknown>>(
    CHECK_UPDATE_ENDPOINT,
    idToken,
    {
      appId: POS_UPDATER_APP_ID,
      channel,
      currentVersionCode,
      deviceId
    }
  );

  if (payload.updateAvailable !== true) {
    return {
      updateAvailable: false,
      appId: String(payload.appId || POS_UPDATER_APP_ID),
      channel: normalizeChannel(String(payload.channel || channel)),
      currentVersionCode: Number(payload.currentVersionCode) || currentVersionCode
    };
  }

  return {
    updateAvailable: true,
    currentVersionCode: Number(payload.currentVersionCode) || currentVersionCode,
    ...normalizeRelease(payload)
  };
};

export const reportPosUpdateEvent = async (
  event: PosUpdateEventName,
  release: Partial<PosUpdateRelease> & {
    currentVersionCode?: number;
    targetVersionCode?: number;
    message?: string;
  }
) => {
  const idToken = await getCurrentEdenAdminIdToken(false);
  const deviceId = getPosDeviceId();
  return postJson<{ ok: boolean; id: string }>(REPORT_EVENT_ENDPOINT, idToken, {
    appId: POS_UPDATER_APP_ID,
    channel: release.channel || POS_UPDATER_DEFAULT_CHANNEL,
    currentVersionCode: release.currentVersionCode,
    deviceId,
    event,
    releaseId: release.releaseId,
    sha256: release.sha256,
    size: release.size,
    targetVersionCode: release.targetVersionCode || release.versionCode,
    versionName: release.versionName,
    message: release.message
  });
};

export const downloadPosApkRelease = async (
  release: PosUpdateRelease
): Promise<DownloadedPosApk> => {
  const idToken = await getCurrentEdenAdminIdToken(true);
  const deviceId = getPosDeviceId();

  if (isNativeUpdaterAvailable()) {
    const downloaded = await EdenPosUpdater.downloadApkToPrivateStorage({
      endpoint: DOWNLOAD_RELEASE_ENDPOINT,
      idToken,
      appId: POS_UPDATER_APP_ID,
      channel: release.channel,
      deviceId,
      releaseId: release.releaseId,
      versionCode: release.versionCode,
      sha256: release.sha256
    });

    return {
      ...downloaded,
      native: true
    };
  }

  const response = await fetch(DOWNLOAD_RELEASE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      appId: POS_UPDATER_APP_ID,
      channel: release.channel,
      deviceId,
      releaseId: release.releaseId,
      versionCode: release.versionCode
    })
  });

  if (!response.ok) {
    const errorPayload = await readJsonResponse<Record<string, unknown>>(response);
    throw new Error(String(errorPayload.error || "Unable to download APK"));
  }

  const blob = await response.blob();
  const actualSha256 = await blobSha256(blob);
  if (actualSha256 !== release.sha256) {
    throw new Error(`APK SHA256 mismatch: ${actualSha256}`);
  }

  return {
    objectUrl: URL.createObjectURL(blob),
    sha256: actualSha256,
    size: blob.size,
    native: false
  };
};

export const verifyDownloadedPosApk = async (
  downloaded: DownloadedPosApk,
  expectedSha256: string
) => {
  if (!downloaded.native || !downloaded.filePath) {
    return {
      ok: normalizeSha256(downloaded.sha256) === normalizeSha256(expectedSha256),
      actualSha256: normalizeSha256(downloaded.sha256)
    };
  }

  return EdenPosUpdater.verifySha256({
    filePath: downloaded.filePath,
    sha256: expectedSha256
  });
};

export const canRequestPackageInstalls = async () => {
  if (!isNativeUpdaterAvailable()) return false;
  const result = await EdenPosUpdater.canRequestPackageInstalls();
  return result.allowed === true;
};

export const openInstallUnknownAppsSettings = async () => {
  if (!isNativeUpdaterAvailable()) return;
  await EdenPosUpdater.openInstallUnknownAppsSettings();
};

export const getPosUpdatePowerStatus =
  async (): Promise<PosUpdatePowerStatus | null> => {
    if (!isNativeUpdaterAvailable()) return null;
    return EdenPosUpdater.getPowerStatus().catch(() => null);
  };

export const launchPosApkInstaller = async (
  downloaded: DownloadedPosApk,
  release: PosUpdateRelease,
  currentVersionCode: number
) => {
  if (!downloaded.native || !downloaded.filePath) {
    throw new Error("Android Package Installer is available only inside the POS APK");
  }

  await reportPosUpdateEvent("install_started", {
    ...release,
    currentVersionCode,
    targetVersionCode: release.versionCode
  });

  localStorage.setItem(
    PENDING_INSTALL_STORAGE_KEY,
    JSON.stringify({
      release,
      currentVersionCode,
      createdAt: new Date().toISOString()
    })
  );

  return EdenPosUpdater.launchPackageInstaller({
    filePath: downloaded.filePath
  });
};

export const reportPendingPosInstallIfComplete = async () => {
  const raw = localStorage.getItem(PENDING_INSTALL_STORAGE_KEY);
  if (!raw) return false;

  const marker = JSON.parse(raw) as {
    release?: PosUpdateRelease;
    currentVersionCode?: number;
  };
  if (!marker.release?.versionCode) {
    localStorage.removeItem(PENDING_INSTALL_STORAGE_KEY);
    return false;
  }

  const installed = await getInstalledPosVersion();
  if (installed.versionCode < marker.release.versionCode) {
    return false;
  }

  await reportPosUpdateEvent("installed", {
    ...marker.release,
    currentVersionCode:
      marker.currentVersionCode || marker.release.versionCode,
    targetVersionCode: marker.release.versionCode,
    message: `Installed ${installed.versionName}/${installed.versionCode}`
  });
  localStorage.removeItem(PENDING_INSTALL_STORAGE_KEY);
  return true;
};
