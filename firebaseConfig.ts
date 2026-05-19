// firebaseConfig.ts
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCCTfcD9XFoDHFvMKyPlvHMCQeKSDmF3bI",
  authDomain: "leituracode.firebaseapp.com",
  projectId: "leituracode",
  storageBucket: "leituracode.firebasestorage.app",
  messagingSenderId: "739461015609",
  appId: "1:739461015609:web:1af7be8d209e83a44345e8"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);