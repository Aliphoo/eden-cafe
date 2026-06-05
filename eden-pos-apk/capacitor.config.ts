import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.personal.pos",
  appName: "Eden Cafe POS",
  plugins: {
    FirebaseAuthentication: {
      authDomain: "edencafe-d9095.firebaseapp.com",
      providers: ["google.com"],
      skipNativeAuth: true
    }
  },
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
