# إصلاح Google OAuth — Controller 3.7.4

## ما تم إصلاحه

Google أعاد في البيئة الفعلية: `invalid_request — client_secret is missing` رغم أن عميل OAuth من نوع Desktop. الإصدار 3.7.4 يدعم هذا المسار بدون وضع السر في السورس أو Firebase.

- يبقى Authorization Code Flow مع PKCE وloopback على `127.0.0.1` بمنفذ عشوائي.
- Desktop Client ID أُدخل من لقطة Google Cloud داخل `src/config/google-oauth.json`:
  `774632785801-vcnb05dlg87mgp9105fb8065fndnmv9e.apps.googleusercontent.com`
- البريد المتوقع: `dr.taheralajaclinic@gmail.com`.
- Client Secret **غير موجود في السورس** لأن لقطة الشاشة تعرضه مقنعاً فقط.
- عند أول ضغط على «ربط Google» يظهر مربع محلي يطلب لصق Client Secret الكامل.
- Client Secret يُحفظ مشفراً بـ Electron `safeStorage` في ملف محلي داخل مجلد بيانات التطبيق باسم `google-oauth-client-secret.bin`.
- Refresh Token يبقى مشفراً محلياً في `google-oauth-token.bin`.
- Access Token يبقى في الذاكرة فقط.
- لا ترسل هذه القيم إلى Firebase/Firestore/Hosting.
- السر يُرسل فقط إلى `https://oauth2.googleapis.com/token` عند تبديل الكود وعند تجديد Access Token.

## ما عليك فعله

1. حدّث Controller إلى 3.7.4 وأعد بناء الـEXE.
2. افتح إعدادات الربط واضغط «ربط Google».
3. سيظهر مربع يطلب **Desktop Client Secret**.
4. من صفحة Google Cloud التي أرسلتها، اضغط أيقونة النسخ بجانب **Client secret** والصق القيمة الكاملة. لا تكتب النجوم `****` الظاهرة في الشاشة.
5. اضغط حفظ. بعدها يفتح المتصفح ويكمل Google OAuth.
6. بعد نجاحه ارجع واضغط «تحديث الحالة». يجب أن يظهر الحساب مربوطاً على هذا الجهاز.

إذا كان السر خاطئاً وGoogle أعاد `invalid_client` أو خطأ `client_secret`، يحذف الكونترولر السر المحلي تلقائياً، وفي المحاولة التالية يطلبه من جديد.

## الاختبارات

- `npm run check`: PASS.
- اختبارات Google OAuth/التجديد/الطابور/الأرشيف المركزة: 15/15 PASS.
- محاولة تشغيل كل الاختبارات أعطت 38 اختباراً ناجحاً، بينما 5 ملفات اختبار لم تبدأ بسبب أن تثبيت npm في بيئة التنفيذ لم يكتمل (`jsdom`/`express` غير متاحين فعلياً)، وليس بسبب assertion فاشل في التعديل الجديد.
