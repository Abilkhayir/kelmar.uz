# Kelajak testlari: to'lovdan keyin ochiladigan test sayti

400 ta savol, Google bilan kirish, **Payme** orqali bir marta to'lov. To'lamagan foydalanuvchiga savollar umuman yuborilmaydi (sayt manbasini ochib ham ko'rib bo'lmaydi).

```
frontend/   GitHub Pages'da turadi (index.html, config.js)
worker/     Cloudflare Worker + D1: Google tekshiruvi, Payme Merchant API, savollarni berish
```

Oqim: Google bilan kirish → to'lov yo'q bo'lsa to'lov sahifasi → "Payme orqali to'lash" → Payme sahifasi → Payme serveringizga `PerformTransaction` yuboradi → baza `paid` deb belgilaydi → foydalanuvchi qaytadi va testlar ochiladi.

## 1. Payme Business (kassa)

1. https://business.paycom.uz da ro'yxatdan o'ting va kassa (merchant) oching. Payme odatda yuridik shaxs yoki YaTT talab qiladi, shartlarni ular bilan aniqlang.
2. Kassa sozlamalarida to'lov **rekvizitlari** (account) maydonini `order_id` nomi bilan qo'shing (raqamli).
3. **Merchant ID** va **Key** (parol) ni oling. Sinov uchun Payme test kassasi ham beradi (test kalit alohida bo'ladi).
4. "Endpoint URL" maydoniga keyinroq `https://<worker-manzili>/api/payme` yozasiz (4-qadamdan keyin).

Menyu nomlari Payme tomonidan o'zgarishi mumkin, topolmasangiz Payme qo'llab-quvvatlashiga yozing.

## 2. Google Client ID

1. https://console.cloud.google.com → yangi loyiha → **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
2. **Authorized JavaScript origins** ga yozing: `https://USERNAME.github.io` (oxirida `/` yo'q).
3. Client ID ni oling (`....apps.googleusercontent.com`). Consent screen so'ralsa, to'ldirib "Publish" qiling.

## 3. GitHub

1. Bu papkani yangi repoga yuklang (`main` branch).
2. Repo **Settings → Pages → Source: GitHub Actions** ni tanlang. `frontend/` har pushda avtomatik chiqadi.
3. Sayt manzili: `https://USERNAME.github.io/REPO/`.

## 4. Cloudflare Worker (backend)

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create kelajak_test          # chiqqan database_id ni wrangler.toml ga qo'ying
npm run db:init                              # jadvallarni yaratadi
npx wrangler secret put PAYME_KEY            # Payme Key
npx wrangler secret put SESSION_SECRET       # uzun tasodifiy matn (masalan: openssl rand -hex 32)
npx wrangler deploy
```

`worker/wrangler.toml` ichida to'ldiring: `PAYME_MERCHANT_ID`, `PRICE_UZS`, `ALLOWED_ORIGIN`, `SITE_URL`, `GOOGLE_CLIENT_ID`.
Deploydan keyin Worker manzili chiqadi (`https://kelajak-test-api.<hisob>.workers.dev`).

## 5. Ulash

1. `frontend/config.js` ga Worker manzili va Google Client ID ni yozing, GitHub'ga push qiling.
2. Payme kassasida Endpoint URL: `https://<worker-manzili>/api/payme`.
3. Avval `PAYME_CHECKOUT_URL = "https://test.paycom.uz"` (test) bilan sinang. Payme kabinetida test so'rovlar (sandbox) bor: ularning barchasi o'tishi kerak. Keyin `https://checkout.paycom.uz` ga o'tkazib, haqiqiy kalitni `secret put PAYME_KEY` bilan almashtiring va qayta `wrangler deploy` qiling.

## Narx yoki savollarni o'zgartirish

- Narx: `PRICE_UZS` (so'mda), keyin `wrangler deploy`.
- Savollar: `worker/src/questions.js`, keyin `wrangler deploy`.

## Bilish kerak

- Test natijalari (tarix, tayyorgarlik %) hozircha foydalanuvchining o'z brauzerida saqlanadi. Boshqa qurilmada kirsa, ko'rinmaydi. Serverga saqlash kerak bo'lsa, D1 ga jadval qo'shish mumkin.
- To'lov qaytarilsa (Payme `CancelTransaction`), kirish huquqi avtomatik olinadi.
- Karta ma'lumotlari bu tizimdan o'tmaydi, to'lov faqat Payme sahifasida bo'ladi.
- Google tokenini Google'ning `tokeninfo` xizmati tekshiradi. Juda katta yuklamada JWKS bilan lokal tekshiruvga o'tish mumkin.
- Lokal sinash: `worker/.dev.vars` ga `PAYME_KEY=...` va `SESSION_SECRET=...` yozib, `npm run dev`.
