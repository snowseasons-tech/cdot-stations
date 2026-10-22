// Generates the VAPID key pair that identifies this server to the phone push services (Apple, Google, Mozilla).
// Run once; keep the private key secret like STATUS_TOKEN, and don't change the keys later (every phone would have
// to subscribe again).
//   node scripts/generate-vapid-keys.js
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('\nAlso set VAPID_SUBJECT to a mailto: address push services can contact, e.g. VAPID_SUBJECT=mailto:you@example.com');
