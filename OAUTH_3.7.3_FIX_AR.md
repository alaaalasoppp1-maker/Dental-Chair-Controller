# Controller 3.7.3 — Google OAuth token exchange fix/diagnostics

## ما الذي أصلح؟
- أبقى Desktop OAuth + PKCE + loopback على 127.0.0.1 بدون Client Secret.
- يرسل طلب token exchange كـ form-urlencoded string صريح، بما فيه `code_verifier`، لتجنب اختلافات serialization في Electron/Node.
- يعرض `error` و`error_description` الحقيقيين القادمين من Google عند فشل token exchange بدل `google_token_exchange_failed` العام فقط.
- يحفظ تشخيصاً محلياً آمناً في `google-oauth-last-error.json` داخل userData. لا يحتوي authorization code أو code_verifier أو access token أو refresh token.
- يحذف ملف التشخيص تلقائياً عند نجاح الربط.
- نفس الصيغة الصريحة استُخدمت لتجديد access token من refresh token.

## ما لم يتغير؟
- لا Client Secret.
- لا Firebase Functions / Blaze.
- refresh token يبقى مشفراً بـ Electron safeStorage.
- access token يبقى في الذاكرة.
- Desktop Client ID الحالي يبقى كما هو.

## الاختبارات
- OAuth/local + queue + legacy bind: 9/9 PASS.
- `npm run check`: PASS.

## ماذا أفعل؟
1. أغلق Controller بالكامل.
2. طبّق Patch 3.7.3 فوق سورس 3.7.2 واختر Replace.
3. لا تستبدل `src/config/google-oauth.json`؛ الـPatch لا يحتويه أصلاً.
4. أعد Build وشغّل 3.7.3.
5. اضغط ربط Google مرة واحدة.
6. إذا فشل، انسخ السطر الذي يبدأ `Google:` من صفحة المتصفح؛ سيظهر السبب الحقيقي مثل `invalid_grant — ...`.
