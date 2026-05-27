import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAbNysIXcBwGKZe6nHJUivqyZxS2PwnCfg",
  authDomain: "edencafe-d9095.firebaseapp.com",
  projectId: "edencafe-d9095",
  storageBucket: "edencafe-d9095.firebasestorage.app",
  messagingSenderId: "962163014966",
  appId: "1:962163014966:web:f22614bfa594c7fd1cc797",
  measurementId: "G-QXGQVWB8LH"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const provider = new GoogleAuthProvider();

export { app, auth, db, provider, storage };
