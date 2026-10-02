import webpush from "web-push";

// Generates a VAPID key pair for web push. Put both in your .env (or shell).
const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
